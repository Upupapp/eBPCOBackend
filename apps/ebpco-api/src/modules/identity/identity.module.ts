import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';

import { AppConfig, CONFIG } from '../../config/app-config';
import { StructuredLogger } from '../../common/logging/logger';
import { ACCOUNT_REPOSITORY, AccountRepository } from './application/account.repository';
import { IdentityService } from './application/identity.service';
import { SESSION_REPOSITORY, SessionRepository } from './application/session.repository';
import { TokenService } from './application/token.service';
import { PasswordHasher } from './domain/password-hasher';
import { PasswordPolicy } from './domain/password-policy';
import { PostgresAccountRepository } from './infrastructure/postgres-account.repository';
import { PostgresSessionRepository } from './infrastructure/postgres-session.repository';
import { SQL_CLIENT } from '../../persistence/persistence.module';
import { AccountStatusReader } from './application/account-status';
import { PASSWORD_RESET_REPOSITORY, PasswordResetRepository } from './application/password-reset.repository';
import { PostgresPasswordResetRepository } from './infrastructure/postgres-password-reset.repository';
import { ComplianceModule } from '../compliance/compliance.module';
import { SqlClient } from '../../persistence/sql-client';
import { LocalBreachedPasswordScreen } from './infrastructure/breached-password-screen';
import { AuthController, MeController } from './transport/auth.controller';
import { AuthenticationGuard } from './transport/guards/authentication.guard';
import { AuditService } from '../compliance/application/audit.service';
import { StaffDirectoryService } from './application/staff-directory.service';
import { StaffDirectoryController } from './transport/staff-directory.controller';
import { AccessRequestService } from './application/access-request.service';
import { StaffAccessService } from './application/staff-access.service';
import {
  AccessRequestController, StaffAccessController, StaffAccessRequestsController,
} from './transport/access-request.controller';
import { ContactVerificationService } from './application/contact-verification.service';
import { ContactsController } from './transport/contacts.controller';
import { MfaController } from './transport/mfa.controller';
import { SecretBox } from './domain/secret-box';
import { TotpService } from './application/totp.service';
import { replayedRefreshToken } from '../compliance/domain/security-events';
import { RefusalRecorder } from './application/refusal-recorder';

/**
 * Identity, wired.
 *
 * The repositories are bound to their in-memory implementations here and
 * nowhere else, so TAB 04 swaps them for PostgreSQL by changing two lines
 * rather than by touching the domain. Everything above the port depends on the
 * interface and has never seen a database.
 */
@Global()
@Module({
  imports: [ComplianceModule],
  controllers: [AuthController, MeController, StaffDirectoryController, ContactsController,
    MfaController, AccessRequestController, StaffAccessRequestsController,
    StaffAccessController],
  providers: [
    {
      provide: PASSWORD_RESET_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient): PasswordResetRepository =>
        new PostgresPasswordResetRepository(db),
    },
    {
      provide: TotpService,
      inject: [SQL_CLIENT, CONFIG],
      useFactory: (db: SqlClient, config: AppConfig) => new TotpService(
        db,
        // In development the key may be empty; the box turns whatever it is
        // given into 32 bytes, and the config refuses an empty one outside
        // development.
        new SecretBox(config.TOTP_ENCRYPTION_KEY || 'development-only-totp-key'),
        `eBPCO ${config.EBPCO_ENVIRONMENT === 'production' ? '' : config.EBPCO_ENVIRONMENT}`.trim(),
      ),
    },
    {
      provide: ContactVerificationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new ContactVerificationService(db),
    },
    {
      provide: StaffDirectoryService,
      inject: [SQL_CLIENT, AuditService],
      useFactory: (db: SqlClient, audit: AuditService) => new StaffDirectoryService(db, audit),
    },
    // Becoming staff is a request a super admin approves. Provided beside the
    // directory rather than in a module of its own: they are two halves of one
    // question — who may act on permit records — and separating them would let
    // one grow a rule the other does not honour.
    {
      provide: AccessRequestService,
      inject: [SQL_CLIENT, AuditService],
      useFactory: (db: SqlClient, audit: AuditService) => new AccessRequestService(db, audit),
    },
    {
      provide: StaffAccessService,
      inject: [SQL_CLIENT, AuditService],
      useFactory: (db: SqlClient, audit: AuditService) => new StaffAccessService(db, audit),
    },
    {
      provide: AccountStatusReader,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new AccountStatusReader(db),
    },

    // Bound here and nowhere else. The in-memory implementations still exist,
    // and the shared contract suite holds both to identical behaviour, so
    // "works in tests, fails in production" surfaces as a failing test.
    {
      provide: ACCOUNT_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PostgresAccountRepository(db),
    },
    {
      provide: SESSION_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PostgresSessionRepository(db),
    },

    {
      provide: PasswordHasher,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => new PasswordHasher(undefined, config.PASSWORD_PEPPER),
    },
    {
      provide: PasswordPolicy,
      useFactory: () => new PasswordPolicy(new LocalBreachedPasswordScreen()),
    },
    {
      provide: TokenService,
      inject: [CONFIG, SESSION_REPOSITORY, StructuredLogger, SQL_CLIENT],
      useFactory: (
        config: AppConfig, sessions: SessionRepository, logger: StructuredLogger, db: SqlClient,
      ) =>
        new TokenService({
          accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
          signingKey: new TextEncoder().encode(config.JWT_SIGNING_KEY),
          sessions,
          onSecurityEvent: (event) => {
            // A replayed refresh token is the strongest signal of theft this
            // service can produce on its own. It is logged at warn so it is
            // visible without a query, and carries no credential material.
            logger.warn('security event', {
              event: event.type,
              accountId: event.accountId,
              familyId: event.familyId,
              detail: event.detail,
            });

            // And recorded. D-6, 2026-08-29: until now the single strongest
            // theft signal this service produces existed only as a line on
            // stdout -- unqueryable, unchained, and gone with the container.
            //
            // Fire-and-forget because the caller is a synchronous callback in
            // the middle of revoking a token family: making the revocation wait
            // on an audit write, or fail with it, would trade a security
            // response for a security record.
            void new AuditService(db)
              .append(replayedRefreshToken(event.accountId, event.familyId))
              .catch((cause: unknown) => logger.error('security event not recorded', {
                event: event.type,
                reason: cause instanceof Error ? cause.message : String(cause),
              }));
          },
        }),
    },
    {
      provide: IdentityService,
      inject: [ACCOUNT_REPOSITORY, TokenService, PasswordHasher, PasswordPolicy,
        PASSWORD_RESET_REPOSITORY, TotpService, SQL_CLIENT, StructuredLogger],
      useFactory: (
        accounts: AccountRepository,
        tokens: TokenService,
        hasher: PasswordHasher,
        policy: PasswordPolicy,
        resetTickets: PasswordResetRepository,
        totp: TotpService,
        db: SqlClient,
        logger: StructuredLogger,
      ) => new IdentityService(
        accounts, tokens, hasher, policy, resetTickets, () => new Date(), totp,
        new AuditService(db),
        // Surfaced, never swallowed. A sign-in that succeeded and was not
        // recorded is a gap in the accountability chain, and the operator has
        // to be able to see it happened.
        (action, cause) => logger.error('audit entry could not be written', {
          action, reason: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    },

    {
      provide: RefusalRecorder,
      inject: [SQL_CLIENT, StructuredLogger],
      useFactory: (db: SqlClient, logger: StructuredLogger) =>
        new RefusalRecorder(new AuditService(db), (cause) =>
          logger.error('refusal not recorded', {
            reason: cause instanceof Error ? cause.message : String(cause),
          })),
    },

    // Registered globally: a new controller is protected the moment it exists,
    // and opting out is a visible @Public() in the diff. A guard applied per
    // route fails open when someone forgets, and fails silently.
    {
      provide: APP_GUARD,
      inject: [TokenService, Reflector, AccountStatusReader, RefusalRecorder],
      useFactory: (
        tokens: TokenService, reflector: Reflector,
        accounts: AccountStatusReader, refusals: RefusalRecorder,
      ) => new AuthenticationGuard(tokens, reflector, accounts, refusals),
    },
  ],
  exports: [
    AccountStatusReader, IdentityService, TokenService, ACCOUNT_REPOSITORY, SESSION_REPOSITORY,
  ],
})
export class IdentityModule {}
