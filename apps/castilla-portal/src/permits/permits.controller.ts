import { Controller, Get, Param } from '@nestjs/common';

import { PermitCatalogueResponse, PermitDetailResponse } from '../http/contract';
import { ProblemException } from '../http/problem';
import { PermitsRepository } from './permits.repository';
import { POLICIES, Cacheable } from '../http/cache';

@Controller('permits')
export class PermitsController {
  constructor(private readonly permits: PermitsRepository) {}

  @Cacheable(POLICIES.reference, () => 'permits')
  @Get()
  async catalogue(): Promise<PermitCatalogueResponse> {
    return { groups: await this.permits.catalogue() };
  }

  @Cacheable(POLICIES.reference, (p: Record<string, string>) => `permit:${p['slug'] ?? ''}`)
  @Get(':slug')
  async detail(@Param('slug') slug: string): Promise<PermitDetailResponse> {
    const permit = await this.permits.detail(slug);
    if (permit === null) throw ProblemException.notFound('Permit', slug);
    return permit;
  }
}
