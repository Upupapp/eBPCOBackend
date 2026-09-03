import { Controller, Get, Inject } from '@nestjs/common';

import { CONFIG, type AppConfig } from '../../../config/app-config';
import { Public } from '../../identity/transport/guards/public.decorator';

/**
 * What a client must not exceed, read from the server's own configuration.
 *
 * Asked for by the citizen web portal lane, and it closes a real defect class
 * rather than a convenience. They had hard-coded 750,000 bytes as the maximum
 * file size — a number derived correctly from a 1MB body limit, and wrong the
 * moment the limit is raised for production, because a constant on the client
 * refuses files the server would accept. A limit copied into three clients is
 * a limit that disagrees with the server in three different ways.
 *
 * PUBLIC, because a client needs it before it has a token: the upload screen
 * has to validate a file before the applicant has signed in to send it.
 * Nothing here is a secret — a body limit is discoverable by sending one byte
 * too many — and publishing it saves every client from discovering it that way.
 *
 * Deliberately NOT a general capabilities endpoint. Those grow into a list of
 * everything anyone ever wanted to know, kept by nobody. This answers one
 * question, and the day it needs to answer a second, that is a decision to
 * make rather than a field to append.
 */
@Controller('limits')
export class LimitsController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  limits(): Record<string, unknown> {
    const bodyLimit = this.config.BODY_LIMIT_BYTES;

    return {
      upload: {
        /**
         * The largest request body the server will read, in bytes. Anything
         * over it is refused by the HTTP adapter BEFORE any handler runs, so
         * the answer is a bare 413 and NOT an RFC 9457 problem document.
         */
        maxRequestBytes: bodyLimit,
        /**
         * The largest FILE that fits, in bytes — which is the number a client
         * actually needs and is not the one above.
         *
         * A file is sent as base64 inside a JSON object, so it arrives about a
         * third larger: base64 of n bytes is ceil(n/3)*4. The rest of the
         * envelope — the field names, the quotes, `fileName` and `label` — is
         * allowed for generously here rather than exactly, because a client
         * that computes this itself has to know the envelope, and a client that
         * guesses it will guess low every time.
         *
         * Derived, never stored. It moves with BODY_LIMIT_BYTES, which is the
         * whole point of serving it.
         */
        maxFileBytes: Math.max(0, Math.floor((bodyLimit - ENVELOPE_BYTES) * 3 / 4)),
        /**
         * How the file is carried. Named so a client is not left to infer it
         * from an example: this service takes base64 in a JSON body, not
         * multipart, and never a pre-signed upload to object storage.
         */
        encoding: 'base64-in-json',
      },
    };
  }
}

/**
 * Room for everything in the upload body that is not the file.
 *
 * `fileName` (255), `label` (200), `requirementCode` (100), an application id,
 * the JSON structure around them, and slack. Generous on purpose: being a
 * kilobyte pessimistic costs an applicant nothing, and being one byte
 * optimistic costs them a 413 with no explanation.
 */
const ENVELOPE_BYTES = 2_048;
