import { Controller, Get, Header, Param, Query } from '@nestjs/common';

import { ProblemException } from '../http/problem';
import { AnnouncementsRepository } from './announcements.repository';

const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

function positiveInt(raw: string | undefined, fallback: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw ProblemException.badRequest(`'${name}' must be a non-negative whole number.`);
  }
  return Math.min(value, max);
}

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsRepository) {}

  @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string): Promise<unknown> {
    const take = Math.max(1, positiveInt(limit, DEFAULT_PAGE, MAX_PAGE, 'limit'));
    const skip = positiveInt(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const { announcements, total } = await this.announcements.list(new Date(), take, skip);
    return { announcements, total, limit: take, offset: skip };
  }

  /**
   * The header badge's number.
   *
   * Cacheable for a minute: it is called on every page load of every page, and
   * a municipal announcement that appears 60 seconds late has cost nobody
   * anything. `public` because the answer is the same for every reader — there
   * is no per-user unread state here, deliberately.
   */
  @Get('count')
  @Header('Cache-Control', 'public, max-age=60')
  async count(): Promise<{ count: number }> {
    return { count: await this.announcements.count(new Date()) };
  }

  @Get(':slug')
  async detail(@Param('slug') slug: string): Promise<unknown> {
    const announcement = await this.announcements.bySlug(slug, new Date());
    // Absent covers three different situations — never published, scheduled for
    // later, withdrawn — and says the same thing about all of them, because
    // "there is a draft you cannot see" is itself information.
    if (announcement === null) throw ProblemException.notFound('Announcement', slug);
    return announcement;
  }
}
