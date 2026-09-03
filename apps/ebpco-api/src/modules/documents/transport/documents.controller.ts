import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { Public, RequireScopes } from '../../identity/transport/guards/public.decorator';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { Caller } from '../../applications/domain/application';
import { DocumentService } from '../application/document.service';

/**
 * Uploading, and reading back, an applicant's documents.
 *
 * Base64 in a JSON body rather than multipart. Two reasons, and the second is
 * the real one: the mobile client already queues submissions as JSON offline
 * (TAB 12), and a multipart upload cannot be serialised into that queue without
 * inventing a second storage format for the bytes. The cost is a third more
 * wire size, which for a photographed document on a metered connection is worth
 * counting — and is why the size cap is enforced on the DECODED length rather
 * than the encoded one.
 */

const signedLinkShape = z.object({
  key: z.string().min(1).max(200),
  expires: z.coerce.number().int().min(0),
  n: z.string().min(1).max(64),
  sig: z.string().min(1).max(200),
}).strict();

const uploadShape = z.object({
  fileName: z.string().min(1).max(255),
  label: z.string().min(1).max(200),
  applicationId: z.string().uuid().nullable().optional(),
  /**
   * Which checklist entry this document answers (C-6). Optional: a client that
   * does not know is better off saying nothing than guessing, and a null is
   * read as "not attributed" rather than as a missing requirement.
   */
  requirementCode: z.string().min(1).max(100).nullable().optional(),
  // The cap is on decoded bytes; this bound only stops an absurd body reaching
  // the decoder. The real limit is BODY_LIMIT_BYTES at the adapter and the
  // service's own inspection.
  contentBase64: z.string().min(1).max(40_000_000),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.validation(
      result.error.issues.map((issue) => ({ pointer: `/${issue.path.join('/')}`, message: issue.message })),
    );
  }
  return result.data;
}

function callerOf(request: AuthenticatedRequest): Caller {
  const claims = request.caller;
  if (claims === undefined) {
    throw new ProblemException(ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED);
  }
  return { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes };
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentService) {}

  /**
   * The caller's own uploads that are not attached to any application (C-7).
   *
   * `POST /documents` takes a nullable application id because both clients
   * upload before they file -- so an abandoned wizard session leaves real
   * documents belonging to a real person, attached to nothing. They were
   * retrievable by id and listed by nothing, which means undiscoverable in
   * practice: a citizen could not see what they had left behind, still less
   * decide to finish or abandon it.
   *
   * Only the unattached ones. Documents on an application are already served,
   * in context, by `GET /applications/:id/documents` -- and returning them here
   * too would be a second answer to a question already answered, drifting from
   * the first the moment either changed.
   */
  @Get('me')
  @RequireScopes('documents:read')
  async mine(@Req() request: AuthenticatedRequest): Promise<ReadonlyArray<Record<string, unknown>>> {
    return this.documents.unattachedFor(callerOf(request).accountId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('documents:write')
  async upload(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parse(uploadShape, body);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.length === 0) throw new Error('empty');
    } catch {
      throw ProblemException.validation([
        { pointer: '/contentBase64', message: 'could not be decoded as base64' },
      ]);
    }

    const outcome = await this.documents.upload({
      bytes,
      fileName: input.fileName,
      label: input.label,
      applicationId: input.applicationId ?? null,
      requirementCode: input.requirementCode ?? null,
      caller: callerOf(request),
    });

    if (outcome.ok) {
      // `removedMetadata` is returned rather than silently dropped. A
      // photograph of a permit plan carries GPS coordinates of the site and the
      // device that took it, and an applicant is entitled to know the LGU
      // stripped them — both because it is their data and because it explains
      // why the file they get back is not byte-identical.
      return {
        documentId: outcome.documentId,
        status: outcome.status,
        removedMetadata: outcome.removedMetadata,
      };
    }

    if (outcome.failure.reason === 'infected') {
      // 422, and the file is not stored. Saying so plainly is better than a
      // generic failure that leaves the applicant retrying the same file.
      throw new ProblemException(
        ProblemType.unprocessable, 'A precondition is unmet', HttpStatus.UNPROCESSABLE_ENTITY,
        outcome.failure.detail,
      );
    }
    throw ProblemException.validation([
      { pointer: '/contentBase64', message: outcome.failure.detail },
    ]);
  }

  /**
   * Redeems a signed URL and serves the bytes.
   *
   * **Public, and that is the point.** The signature is the authorisation: a
   * signed URL exists so a download can be fetched without a bearer token, by a
   * browser, an image tag or a download manager. Everything a caller would
   * normally be checked for was checked when the URL was minted, which is why
   * it lives for two minutes.
   *
   * This route did not exist. `signedUrl` has always pointed at
   * `/documents/content`, nothing served it, and every link handed to an
   * applicant answered 404 — so no document could be downloaded, and the
   * integrity check behind it had never run outside a test.
   */
  @Public()
  @Get('content')
  async redeem(
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const link = parse(signedLinkShape, query ?? {});
    const result = await this.documents.redeem(link.key, link.expires, link.n, link.sig);

    if (!result.ok) {
      if (result.reason === 'expired') {
        throw new ProblemException(
          ProblemType.notFound, 'No such resource', HttpStatus.NOT_FOUND,
          'That link has expired. Open the document again to get a new one.',
        );
      }
      if (result.reason === 'integrity') {
        // The stored bytes no longer match the checksum recorded at upload.
        // Refusing is the only safe answer: serving them would hand an
        // applicant a document the LGU can no longer vouch for.
        throw new ProblemException(
          ProblemType.internal, 'The request could not be completed', HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      // Invalid and unknown answer alike. Distinguishing them would say whether
      // a guessed key exists.
      throw ProblemException.notFound('No such document.');
    }

    void reply
      // ALWAYS an attachment, never inline. These are files an applicant
      // uploaded, served from the API's own origin: an HTML or SVG document
      // rendered inline here is stored cross-site scripting against every
      // officer who opens it.
      .header('content-disposition', `attachment; filename="${safeFileName(result.fileName)}"`)
      .header('content-type', result.contentType)
      // And never sniffed into something executable regardless of what the
      // declared type says.
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');

    return result.bytes;
  }

  /**
   * A short-lived URL for the bytes.
   *
   * Not the bytes themselves: a document is megabytes and this process should
   * not be a file server. Access is checked here, once, and the URL that comes
   * back is signed and expires — so a link shared by accident stops working.
   */
  @Get(':documentId/content')
  @RequireScopes('documents:read')
  async content(
    @Req() request: AuthenticatedRequest,
    @Param('documentId') documentId: string,
  ): Promise<Record<string, unknown>> {
    const access = await this.documents.contentUrl(documentId, callerOf(request));
    // Not-yours and not-there answer alike, as everywhere else.
    if (!access.ok) throw ProblemException.notFound('No such document.');
    return { url: access.url };
  }
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Applicants name their own files, and a name containing a quote or a newline
 * would let the rest of the header be rewritten — a response-splitting hole
 * dressed as a document called `plan".pdf`.
 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]/g, '_').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'document';
}
