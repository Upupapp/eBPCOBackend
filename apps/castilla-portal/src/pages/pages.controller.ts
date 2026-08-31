import { Controller, Get, Param } from '@nestjs/common';

import { ProblemException } from '../http/problem';
import { ContentPage, PageRevision, PagesRepository } from './pages.repository';
import { POLICIES, Cacheable } from '../http/cache';

@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesRepository) {}

  @Cacheable(POLICIES.reference, () => 'pages')
  @Get()
  async list(): Promise<{ pages: ContentPage[] }> {
    return { pages: await this.pages.list() };
  }

  @Get(':key/revisions')
  async revisions(@Param('key') key: string): Promise<{ revisions: PageRevision[] }> {
    if (await this.pages.byKey(key) === null) throw ProblemException.notFound('Page', key);
    return { revisions: await this.pages.revisions(key) };
  }

  @Cacheable(POLICIES.reference, (p: Record<string, string>) => `page:${p['key'] ?? ''}`)
  @Get(':key')
  async detail(@Param('key') key: string): Promise<ContentPage> {
    const page = await this.pages.byKey(key);
    if (page === null) throw ProblemException.notFound('Page', key);
    return page;
  }
}
