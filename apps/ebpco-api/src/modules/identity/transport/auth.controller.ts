import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Req, Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { ACCOUNT_REPOSITORY, AccountRepository } from '../application/account.repository';
import { IdentityService } from '../application/identity.service';
import { ErasureService } from '../../compliance/application/erasure.service';
import { StaffAccessService } from '../application/staff-access.service';
import { RectificationService } from '../application/rectification.service';
import { DataExportService } from '../../compliance/application/data-export.service';
import { ProfilePhotoService } from '../application/profile-photo.service';
import { Public, RequireScopes } from './guards/public.decorator';
import type { AuthenticatedRequest } from './guards/authentication.guard';
import { AccountRecoveryMailer } from '../application/account-recovery-mailer';
import { RegistrationVerificationService } from '../application/registration-verification.service';
import { ContactVerificationMailer } from '../application/contact-verification-mailer';
import { StructuredLogger } from '../../../common/logging/logger';
import { CASTILLA_BARANGAYS, CASTILLA_CITY, CASTILLA_PROVINCE } from '../../businesses/castilla-barangays';

/**
 * The identity endpoints.
 *
 * Every unauthenticated one returns the same answer whether or not the address
 * is registered. That is the single constraint shaping this controller: an
 * applicant register that can be enumerated tells anyone who asks which of
 * their neighbours has applied for a building permit.
 */

const credentials = z.object({
  grantType: z.literal('password'),
  email: z.string().email().max(320),
  // Bounded. scrypt's cost comes from its parameters rather than the input
  // length, but the body limit still allows a one-megabyte "password" that has
  // to be read, copied and hashed on every attempt — and an unbounded field on
  // the one endpoint an attacker can call without credentials is free work for
  // them. 512 is far above anything a passphrase needs and far below anything
  // worth defending against.
  password: z.string().min(1).max(512),
  // Six digits. Accepting an arbitrary string here let a caller send a
  // megabyte to a comparison that only ever looks at six characters.
  totp: z.string().regex(/^\d{6}$/, 'must be six digits').optional(),
});

const registration = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(320),
  mobileNumber: z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'must be 09XXXXXXXXX or +639XXXXXXXXX'),
  password: z.string().min(1).max(512),
  // Migration 038. Optional, not required: the mobile client's live request
  // still sends exactly the five fields above, and `.strict()` below rejects
  // an UNKNOWN field, never an omitted optional one, so that keeps working
  // unchanged.
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
  sex: z.enum(['Male', 'Female', 'Prefer not to say']).optional(),
  civilStatus: z.enum(['Single', 'Married', 'Widowed', 'Separated', 'Divorced']).optional(),
  nationality: z.string().min(1).max(100).optional(),
  // Migration 036, added here 2026-09-19. The web portal's registration form
  // has asked Step 2 for all six of these — house number/street, barangay,
  // city, province, postal code, plus middle name on Step 1 — since before
  // this endpoint existed, marked required and blocking progress to Step 3
  // without them. None of the six had a field here, so `AuthService
  // .register()` on that portal quietly never sent what its own form had
  // just collected and validated: a citizen who filled in a real address
  // believing it was being recorded found it blank on their own Profile
  // screen afterward, with no error anywhere along the way. Optional here
  // for the same reason dateOfBirth/etc. are: the mobile client's request
  // still sends none of this and must keep registering cleanly.
  middleName: z.string().min(1).max(100).optional(),
  street: z.string().min(1).max(200).optional(),
  barangay: z.enum(CASTILLA_BARANGAYS).optional(),
  city: z.literal(CASTILLA_CITY).optional(),
  province: z.literal(CASTILLA_PROVINCE).optional(),
  postalCode: z.string().regex(/^[0-9]{4}$/, 'a Philippine postal code is four digits').optional(),
// `.strict()`, because Zod's default SILENTLY STRIPS what it does not know.
// A client adding an unlisted field here would get 202 and the field would
// vanish -- success reported over data thrown away, which is the exact
// failure the comment above just described for six fields that used to be
// on this list's blind side.
}).strict();

/**
 * The RA 10173 §16(d) right to have inaccurate personal data corrected.
 *
 * `.strict()`, and that is the point rather than a habit: `email` is the
 * sign-in identity and is deliberately NOT rectifiable here, so a client
 * sending it is told so instead of watching the field be silently dropped and
 * believing the address changed.
 *
 * Every field optional, but at least one required -- an empty PATCH is a
 * request that means nothing, and answering it 200 would report a correction
 * that never happened.
 */
const rectification = z.object({
  firstName: z.string().min(1).max(100).optional(),
  // Nullable as well as optional, and the two mean different things: absent
  // leaves the field alone, null clears it. A citizen who has no middle name,
  // or who typed one by mistake, must be able to say so -- a right to correct
  // that cannot remove is half a right.
  middleName: z.string().min(1).max(100).nullable().optional(),
  lastName: z.string().min(1).max(100).optional(),
  mobileNumber: z.string()
    .regex(/^(09\d{9}|\+639\d{9})$/, 'must be 09XXXXXXXXX or +639XXXXXXXXX').optional(),
  // The address the office writes to (migration 036). `street`, not `address`:
  // `businesses` already calls this street, and a second spelling of one idea
  // inside one service is the defect D-10 spent a migration undoing.
  street: z.string().min(1).max(200).nullable().optional(),
  barangay: z.enum(CASTILLA_BARANGAYS).nullable().optional(),
  city: z.literal(CASTILLA_CITY).nullable().optional(),
  province: z.literal(CASTILLA_PROVINCE).nullable().optional(),
  postalCode: z.string().regex(/^[0-9]{4}$/, 'a Philippine ZIP is four digits')
    .nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'name at least one field to correct' },
);

const registerEmailVerificationRequest = z.object({ email: z.string().email().max(320) }).strict();
const registerEmailVerificationConfirm = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^\d{6}$/, 'must be the six-digit code'),
}).strict();

const refreshRequest = z.object({ refreshToken: z.string().min(1) });
const revokeRequest = z.object({ allSessions: z.boolean().optional() });
const forgotRequest = z.object({ email: z.string().email().max(320) });
const resetRequest = z.object({
  token: z.string().uuid('must be a reset token'),
  password: z.string().min(1).max(512),
});
const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
}).strict();

const photoUploadRequest = z.object({
  fileName: z.string().min(1).max(255),
  // The cap is on decoded bytes; this bound only stops an absurd body
  // reaching the decoder. The real limit is `ProfilePhotoService`'s own
  // `MAX_PHOTO_BYTES`, applied to the decoded bytes.
  contentBase64: z.string().min(1).max(8_000_000),
}).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly registrationVerification: RegistrationVerificationService,
    private readonly registrationMailer: ContactVerificationMailer,
    private readonly recoveryMailer: AccountRecoveryMailer,
    private readonly logger: StructuredLogger,
  ) {}

  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(credentials, body);
    const outcome = await this.identity.authenticate(input.email, input.password, input.totp);

    if (!outcome.ok) {
      if (outcome.reason === 'mfa-required') {
        // Distinguishable only because the caller has already proven the
        // password, so it reveals nothing they did not already know.
        throw new ProblemException(
          '/problems/mfa-required',
          'A second factor is required',
          HttpStatus.UNAUTHORIZED,
          'Enter the code from your authenticator app.',
        );
      }
      if (outcome.reason === 'mfa-invalid') {
        // Same reasoning as mfa-required above — the password is already
        // proven by the time this is reachable, so naming the code (not the
        // password) as what was wrong reveals nothing new.
        throw new ProblemException(
          '/problems/mfa-invalid',
          'The code was not accepted',
          HttpStatus.UNAUTHORIZED,
          "That code wasn't accepted. Try the next one from your authenticator app.",
        );
      }
      throw new ProblemException(
        ProblemType.unauthorized,
        'Check your email and password and try again',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      accessToken: outcome.tokens.accessToken,
      refreshToken: outcome.tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: outcome.tokens.expiresIn,
      scopes: outcome.tokens.scopes,
    };
  }

  @Public()
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(refreshRequest, body);
    try {
      const tokens = await this.identity.refresh(input.refreshToken);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        scopes: tokens.scopes,
      };
    } catch {
      // Including replay. A caller who learns their token was rejected *because
      // it was replayed* learns the theft was detected.
      throw new ProblemException(
        ProblemType.unauthorized,
        'That refresh token was not accepted',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  @Post('revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const input = parse(revokeRequest, body ?? {});
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    if (input.allSessions === true) {
      await this.identity.signOutEverywhere(caller.sub);
      return;
    }
    await this.identity.signOut(caller.sid);
  }

  /**
   * Verifying an email BEFORE the account it will belong to exists — Step 2
   * of the web portal's own registration wizard, not a post-signup extra.
   * Public, like `register` itself: there is no account yet to hold a scope
   * against, and the same anti-enumeration posture applies (this reveals
   * nothing about whether the address already has an account — `request`
   * below always answers 202 the same way, and `confirm` never says
   * "already registered").
   */
  @Public()
  @Post('register/email/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestRegistrationEmailCode(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(registerEmailVerificationRequest, body);
    const result = await this.registrationVerification.request(input.email);
    if (!result.ok) {
      // 'too-soon' is a state the address is in (a code was just issued),
      // not a validation failure — same 409 contacts.controller.ts's own
      // refuse() uses for the identical reason.
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this', HttpStatus.CONFLICT, result.detail,
      );
    }

    if (!this.registrationMailer.real) {
      return {
        delivery: 'not-sent',
        detail: 'The request is recorded. The LGU has no message provider configured yet, '
          + 'so no code has been sent — try again once one is set up.',
      };
    }
    try {
      await this.registrationMailer.sendCode(input.email, result.code);
    } catch (cause) {
      this.logger.error('registration email verification code could not be sent', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return {
        delivery: 'failed',
        detail: 'The code was generated, but the email could not be sent just now. Try again in a moment.',
      };
    }
    return {
      delivery: 'sent',
      detail: 'A 6-digit code was sent to this email address. It expires in a few minutes.',
    };
  }

  @Public()
  @Post('register/email/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmRegistrationEmailCode(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(registerEmailVerificationConfirm, body);
    const result = await this.registrationVerification.confirm(input.email, input.code);
    if (!result.ok) {
      // Every reason (no-challenge, expired, wrong-code, too-many-attempts)
      // is a state the challenge is in, not a missing thing — same mapping
      // contacts.controller.ts's own refuse() uses for the identical shape.
      throw new ProblemException(
        ProblemType.conflict, 'The resource is not in a state that permits this',
        HttpStatus.CONFLICT, result.detail,
      );
    }
    // Confirmed, not yet consumed — `register()` spends this the moment an
    // account is actually created for this exact email. Nothing here says
    // "you may now register"; that would be true of any six-digit answer,
    // right or wrong, and is exactly the fabrication this whole feature
    // exists to not perform.
    return { confirmed: true };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() body: unknown): Promise<void> {
    const input = parse(registration, body);
    // Spent here, once, right before the account is created — not earlier,
    // so a confirmed-then-abandoned Step 2 cannot be replayed against a
    // different registration later than its own window (see
    // RegistrationVerificationService.consumeConfirmedProof's own doc
    // comment). `false` for the mobile client (which never calls
    // register/email/request at all) is exactly today's behaviour: an
    // unverified email, verified later from Profile.
    const emailPreVerified = await this.registrationVerification.consumeConfirmedProof(input.email);

    // `mobileNumber` is validated above and was, until 2026-08-31, discarded
    // here — the service did not even accept it.
    const result = await this.identity.register({
      email: input.email,
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
      mobileNumber: input.mobileNumber,
      dateOfBirth: input.dateOfBirth,
      sex: input.sex,
      civilStatus: input.civilStatus,
      nationality: input.nationality,
      middleName: input.middleName,
      street: input.street,
      barangay: input.barangay,
      city: input.city,
      province: input.province,
      postalCode: input.postalCode,
      emailPreVerified,
    });

    // A weak password IS reported: that is the caller's own input, not a fact
    // about who else has an account.
    if (!result.accepted) {
      throw ProblemException.validation(
        result.rejections.map((rejection) => ({ pointer: '/password', message: rejection.message })),
      );
    }
    // Otherwise 202, identically, whether or not the address was already used.
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgot(@Body() body: unknown): Promise<void> {
    const input = parse(forgotRequest, body);
    // The ticket itself is never put in the RESPONSE: returning it would make
    // this endpoint a password reset for anyone who knows an address. It is
    // still used here, to actually deliver the link — see the module doc
    // comment in `account-recovery-mailer.ts`.
    const ticket = await this.identity.beginPasswordReset(input.email);

    // Fire-and-forget, and deliberately not awaited: awaiting an SMTP round
    // trip only for addresses that resolve to a real account would make this
    // endpoint measurably slower for a known address than an unknown one,
    // which is exactly the oracle its identical response is supposed to deny.
    if (ticket !== null) {
      void this.recoveryMailer.sendPasswordSetupLink(input.email, ticket).catch((cause: unknown) => {
        this.logger.error('password-reset email could not be sent', {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reset(@Body() body: unknown): Promise<void> {
    const input = parse(resetRequest, body);
    const result = await this.identity.completePasswordReset(input.token, input.password);

    if (!result.ok) {
      if (result.rejections.length > 0) {
        throw ProblemException.validation(
          result.rejections.map((rejection) => ({ pointer: '/password', message: rejection.message })),
        );
      }
      throw new ProblemException(
        ProblemType.badRequest,
        'That reset link is no longer valid',
        HttpStatus.BAD_REQUEST,
        'Request a new one.',
      );
    }
  }

  /**
   * Changing a password from inside an active session. No `@RequireScopes`,
   * same as `revoke` above: the account acted on is always the caller's own,
   * taken from the token, so being signed in at all is the whole requirement
   * — there is no narrower scope this could be gated on.
   */
  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    const input = parse(changePasswordRequest, body);
    const result = await this.identity.changePassword(caller.sub, input.currentPassword, input.newPassword);

    if (!result.ok) {
      if (result.reason === 'weak-password') {
        throw ProblemException.validation(
          result.rejections.map((rejection) => ({ pointer: '/newPassword', message: rejection.message })),
        );
      }
      throw new ProblemException(
        ProblemType.unauthorized, 'That is not your current password', HttpStatus.UNAUTHORIZED,
      );
    }
  }
}

@Controller('me')
export class MeController {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly erasure: ErasureService,
    private readonly dataExports: DataExportService,
    private readonly staffAccess: StaffAccessService,
    private readonly rectification: RectificationService,
    private readonly photos: ProfilePhotoService,
  ) {}

  /**
   * The RA 10173 §18 right to a portable copy of your own data.
   *
   * 202 and a request id, not the file. An export reads every application,
   * document record, payment and notification the applicant has, and doing that
   * inside a request times out for exactly the people with the most data — who
   * are the ones most likely to be asking.
   *
   * Pressing the button twice returns the SAME request rather than an error.
   * A second press is not a second request, and refusing would read as the LGU
   * declining to answer a statutory right.
   */
  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('profile:read')
  async requestExport(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return { ...(await this.dataExports.request(callerOf(request))) };
  }

  /**
   * Where a request has got to.
   *
   * The contract says the feed carries the result. It does not yet: emitting a
   * notification needs a catalog entry the mobile client can parse, and its
   * enum parser throws on an unknown type — so a notice sent before the client
   * knows the type is a crash on a handset. Until the mobile lane adds it, this
   * is how a client finds out, and saying so is better than sending a notice
   * with a dead deep link.
   */
  @Get('export/:requestId')
  @RequireScopes('profile:read')
  async exportStatus(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ): Promise<Record<string, unknown>> {
    const status = await this.dataExports.statusOf(callerOf(request), requestId);
    // Someone else's request answers the same as one that does not exist.
    if (status === null) throw ProblemException.notFound('No such export request.');
    return { ...status };
  }

  /**
   * A short-lived link to the produced file.
   *
   * Separate from the status so the link is minted at the moment it is asked
   * for rather than sitting in a status response somebody screenshots. It
   * expires with the request, and never outlives it.
   */
  @Get('export/:requestId/content')
  @RequireScopes('profile:read')
  async exportContent(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ): Promise<Record<string, unknown>> {
    const url = await this.dataExports.downloadUrl(callerOf(request), requestId);
    if (url === null) {
      throw ProblemException.notFound('That export is not available. It may still be being produced, or it may have expired.');
    }
    return { url };
  }

  /**
   * Correcting what the LGU holds about you (C-3, RA 10173 §16(d)).
   *
   * A statutory right rather than a settings screen, which is why it is
   * audited and why it refuses a field it cannot apply instead of ignoring it.
   *
   * Applicants only. A staff member's name is set by the office on their
   * access request and stands against their acts in the audit trail;
   * correcting it belongs to an administrator, not to self-service.
   */
  @Patch()
  @RequireScopes('profile:write')
  async rectify(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const caller = request.caller;
    if (caller === undefined) {
      throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);
    }
    const input = parse(rectification, body ?? {});

    const outcome = await this.rectification.rectify({ accountId: caller.sub, ...input });
    if (!outcome.ok) {
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
        outcome.detail,
      );
    }

    // The corrected record, read back. A client that has just changed a name
    // should not have to guess whether it took, and returning the row is
    // cheaper than a second request on the screen that most needs certainty.
    //
    // A STRICT SUPERSET of what GET /me returns, and that is the point rather
    // than tidiness. These two shapes overlapped without either containing the
    // other — GET had id/kind/email, PATCH had the verification fields — so a
    // client typing one interface for both got a field that does not exist at
    // runtime whichever way it chose. One shape plus one extra field cannot do
    // that: `mobileVerificationCleared` is the only thing here a read cannot
    // answer, because it describes what THIS request did rather than what the
    // account is.
    const account = await this.accounts.findById(caller.sub);
    const profile = await this.accounts.profileOf(caller.sub);
    return {
      id: caller.sub,
      kind: account?.kind ?? 'applicant',
      email: account?.email ?? null,
      emailVerifiedAt: account?.emailVerifiedAt?.toISOString() ?? null,
      // Present on GET too (see this controller's own note there) — a
      // correction must stay a strict superset of a read, and this is one
      // of the fields that superset promise covers.
      hasPhoto: await this.photos.hasPhoto(caller.sub),
      firstName: profile?.firstName ?? null,
      middleName: profile?.middleName ?? null,
      lastName: profile?.lastName ?? null,
      mobileNumber: profile?.mobileNumber ?? null,
      street: profile?.street ?? null,
      barangay: profile?.barangay ?? null,
      city: profile?.city ?? null,
      province: profile?.province ?? null,
      postalCode: profile?.postalCode ?? null,
      dateOfBirth: profile?.dateOfBirth ?? null,
      sex: profile?.sex ?? null,
      civilStatus: profile?.civilStatus ?? null,
      nationality: profile?.nationality ?? null,
      mobileVerifiedAt: account?.mobileVerifiedAt?.toISOString() ?? null,
      // Stated, not implied. Changing the number cleared the verification that
      // belonged to the old one, and a client that does not re-prompt would
      // leave the citizen with an unverified contact they think is verified.
      mobileVerificationCleared: outcome.mobileVerificationCleared,
    };
  }

  @Get()
  async me(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    const account = await this.accounts.findById(caller.sub);
    // 404 rather than 401: the token verified, so this is a record question.
    if (account === null) throw ProblemException.notFound();

    // Never the verifier, the salt, or the TOTP secret.
    //
    // Roles and scopes ARE returned for staff, and are not a disclosure: the
    // caller learns both from the first request that succeeds or is refused.
    // A staff portal needs them to decide what to put on screen, and the
    // alternative -- a client guessing from a role name it invented -- is how a
    // menu comes to offer actions the server will refuse.
    //
    // The scopes come from the token rather than being recomputed from the
    // roles, so what is reported is exactly what will be enforced. A token
    // issued before a role changed carries the old set, and saying otherwise
    // would describe a session the holder does not have.
    const common = {
      id: account.id,
      kind: account.kind,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
      // Present on the READ as well as on the correction, and its absence here
      // was a real defect the citizen web lane hit.
      //
      // PATCH /me returned it and GET /me did not, so a client typing ONE
      // interface for both declared a field that is simply absent at runtime.
      // `undefined` then renders as a verified-looking blank — on the one
      // screen where verification state is the thing being shown. Verification
      // is a property of the account, not a fact about a correction, so the
      // read is where it belongs most.
      mobileVerifiedAt: account.mobileVerifiedAt?.toISOString() ?? null,
      // Whether to draw an avatar and offer `GET /me/photo` — not the bytes
      // themselves. Those are megabytes-adjacent and single-purpose; sending
      // them on every `/me` call (session restore, background refresh) would
      // make the one request every screen depends on carry an image nobody
      // asked to see yet.
      hasPhoto: await this.photos.hasPhoto(account.id),
    };

    if (account.kind === 'staff') {
      // F-32, raised by the admin portal lane. Two omissions, both of which
      // left something built and inert.
      //
      // `fullName`: every officer saw their own EMAIL ADDRESS in the topbar.
      // The name was never missing -- the office types it on the access
      // request and the approver reads it before deciding -- it was dropped
      // when the account was created (migration 034 fixes that, and recovers
      // the names already collected). Null means genuinely not on record, for
      // an account made before that flow existed; it does not mean blank.
      //
      // `level` and `permitTypes`: the access model has three axes -- role,
      // level, and the permit types an officer may work on -- and only roles
      // and scopes were reported. Scopes encode the level, because a view-only
      // officer's token is issued without the authority scopes; nothing
      // encoded the FORMS. So a portal could not tell which permit types to
      // offer, and three built screens had nothing to drive them.
      //
      // `liveAccessFor`, not `accessFor`: a retired permit type must not be
      // offered on a screen. An officer still holds the grant -- it is how
      // their historical work stays attributable -- but it is not something
      // they can file against today.
      const access = await this.staffAccess.liveAccessFor(account.id);
      return {
        ...common,
        fullName: account.fullName,
        roles: account.roles,
        scopes: caller.scopes,
        level: access.level,
        permitTypes: access.permitTypes,
      };
    }

    // An applicant's name and mobile number, which the mobile client reads to
    // greet them and to show what it will send an OTP to. Omitting them was a
    // real defect: the client fell back to empty strings, so every applicant
    // saw a blank name and an empty contact number, and nothing failed loudly
    // enough for anyone to notice. Found by putting a recorded response next to
    // the code that consumes it.
    const profile = await this.accounts.profileOf(account.id);
    return {
      ...common,
      firstName: profile?.firstName ?? null,
      middleName: profile?.middleName ?? null,
      lastName: profile?.lastName ?? null,
      mobileNumber: profile?.mobileNumber ?? null,
      // Where the office writes about an application. Null means NOT RECORDED
      // -- never a blank the citizen chose to leave.
      street: profile?.street ?? null,
      barangay: profile?.barangay ?? null,
      city: profile?.city ?? null,
      province: profile?.province ?? null,
      postalCode: profile?.postalCode ?? null,
      // Migration 038. Same "null means not recorded" contract as the address
      // fields above, not "the citizen left it blank".
      dateOfBirth: profile?.dateOfBirth ?? null,
      sex: profile?.sex ?? null,
      civilStatus: profile?.civilStatus ?? null,
      nationality: profile?.nationality ?? null,
    };
  }

  /**
   * Replacing the profile photo. `PUT`, not `POST`: there is at most one, and
   * a second upload replaces it rather than adding another — the same
   * reasoning `notification-preferences.controller.ts` gives for using PUT
   * over PATCH on a set with no ambiguous partial meaning.
   *
   * `profile:write`, the same scope the rest of this profile screen's own
   * corrections use — a photo is a self-correction like a name or an
   * address, not a document submitted about an application.
   */
  @Put('photo')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('profile:write')
  async uploadPhoto(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);
    const input = parse(photoUploadRequest, body);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.length === 0) throw new Error('empty');
    } catch {
      throw ProblemException.validation([
        { pointer: '/contentBase64', message: 'could not be decoded as base64' },
      ]);
    }

    const outcome = await this.photos.upload(caller.sub, bytes, input.fileName);
    if (!outcome.ok) {
      if (outcome.reason === 'infected') {
        throw new ProblemException(
          ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
          outcome.detail,
        );
      }
      throw ProblemException.validation([{ pointer: '/contentBase64', message: outcome.detail }]);
    }
    return { contentType: outcome.contentType };
  }

  @Delete('photo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('profile:write')
  async removePhoto(@Req() request: AuthenticatedRequest): Promise<void> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);
    await this.photos.remove(caller.sub);
  }

  /**
   * The bytes. `profile:read`, not public: unlike a document link handed to
   * an applicant to open once, this is fetched by the same signed-in citizen
   * who owns it, every time their own Profile screen renders — an ordinary
   * authenticated GET, not a link anyone else would ever hold.
   *
   * `inline`, not `attachment` — the one deliberate deviation from
   * `documents.controller.ts`'s "ALWAYS an attachment" rule, which exists to
   * stop an uploaded file that LOOKS like an image from being rendered as
   * HTML/SVG and executing script. `ProfilePhotoService.upload()` already
   * refused anything that is not a real, structurally-verified JPEG or PNG
   * — not a declared content type, the actual bytes — and `nosniff` below
   * still stands, so there is nothing here for a browser to reinterpret.
   */
  @Get('photo')
  @RequireScopes('profile:read')
  async photo(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const caller = request.caller;
    if (caller === undefined) throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', 401);

    const stored = await this.photos.photoFor(caller.sub);
    if (stored === null) throw ProblemException.notFound('No photo on file.');

    void reply
      .header('content-disposition', 'inline')
      .header('content-type', stored.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return stored.bytes;
  }

  /**
   * The RA 10173 §16(e) right to erasure.
   *
   * 202 rather than 204: the request is accepted and the response says what was
   * erased and what survives. A 204 would be the LGU quietly keeping a permit
   * record while implying it kept nothing, and §16(e) is conditional on there
   * being an overriding legal obligation — so naming the obligation is what
   * makes the retention lawful rather than merely convenient.
   *
   * Not idempotency-keyed. Erasing an already-erased account returns the same
   * receipt, so a replayed request cannot cause a second erasure and a key
   * would guard nothing.
   */
  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('profile:write')
  async erase(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const result = await this.erasure.erase(callerOf(request));
    if (result.ok) {
      const { acceptedAt, erasedCategories, retainedCategories } = result.receipt;
      // `counts` stays out of the response: it names tables, which is internal
      // structure, and the contract's shape is what the client was built to.
      return { acceptedAt, erasedCategories, retainedCategories };
    }

    if (result.reason === 'not-found') throw ProblemException.notFound();
    throw new ProblemException(
      ProblemType.forbidden, 'Not permitted', HttpStatus.FORBIDDEN, result.detail,
    );
  }
}

/**
 * The caller's own account id, from the token and from nowhere else.
 *
 * A function rather than a repeated guard, because every route on `/me` needs
 * it and the one that forgets is the one that takes an account id from
 * somewhere a caller can influence.
 */
function callerOf(request: AuthenticatedRequest): string {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return claims.sub;
}
