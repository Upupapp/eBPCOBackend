import { Controller, Get, Param, Query } from '@nestjs/common';

import { OfficeDetailResponse, OfficeListResponse } from '../http/contract';
import { ProblemException } from '../http/problem';
import { OfficesRepository } from './offices.repository';

@Controller('offices')
export class OfficesController {
  constructor(private readonly offices: OfficesRepository) {}

  @Get()
  async list(@Query('category') category?: string): Promise<OfficeListResponse> {
    if (category !== undefined) {
      // An unknown category returns 400, not an empty list. Empty is a real
      // answer to a real category, and a client that typoed 'finanace' would
      // otherwise be told, truthfully but uselessly, that the LGU has no such
      // offices.
      const known = await this.offices.categories();
      if (!known.includes(category)) {
        throw ProblemException.badRequest(
          `Unknown category '${category}'. Known categories: ${known.join(', ')}.`);
      }
    }
    return { offices: await this.offices.list(category) };
  }

  @Get(':slug')
  async detail(@Param('slug') slug: string): Promise<OfficeDetailResponse> {
    const office = await this.offices.detail(slug);
    if (office === null) throw ProblemException.notFound('Office', slug);
    return office;
  }
}
