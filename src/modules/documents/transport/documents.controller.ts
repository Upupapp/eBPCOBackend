import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException, ProblemType } from '../../../common/problem/problem';
import { RequireScopes } from '../../identity/transport/guards/public.decorator';
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

const uploadShape = z.object({
  fileName: z.string().min(1).max(255),
  label: z.string().min(1).max(200),
  applicationId: z.string().uuid().nullable().optional(),
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
