import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProblemException } from '../http/problem';
import { FormsRepository } from './forms.repository';

@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsRepository) {}

  @Get()
  async list(): Promise<{ forms: Awaited<ReturnType<FormsRepository['list']>> }> {
    return { forms: await this.forms.list() };
  }

  @Get(':familySlug/revisions')
  async revisions(@Param('familySlug') familySlug: string): Promise<{
    revisions: Awaited<ReturnType<FormsRepository['revisions']>>;
  }> {
    const revisions = await this.forms.revisions(familySlug);
    if (revisions.length === 0) throw ProblemException.notFound('Form', familySlug);
    return { revisions };
  }

  /**
   * The download.
   *
   * Not behind authentication, deliberately: these are blank public forms, and
   * gating them defeats the point of the portal. The response is the stored
   * bytes unmodified — no re-generation, no flattening, no compression.
   */
  @Get(':familySlug/download')
  async download(
    @Param('familySlug') familySlug: string,
    @Res() reply: FastifyReply,
    @Query('checksum') checksum?: string,
  ): Promise<void> {
    const form = await this.forms.bytesOf(familySlug, checksum);
    if (form === null) {
      // A JSON problem, never an HTML page and never a 200. A citizen whose
      // browser saved an HTML error page as 'form.pdf' would carry it to the
      // counter and find out there.
      throw ProblemException.notFound('Form', familySlug);
    }

    await reply
      .header('Content-Type', form.contentType)
      // The original filename, so what lands in Downloads is recognisable as
      // the form the page offered.
      .header('Content-Disposition', `attachment; filename="${form.originalFilename}"`)
      .header('Content-Length', String(form.bytes.length))
      .header('X-Content-Type-Options', 'nosniff')
      .send(form.bytes);
  }
}
