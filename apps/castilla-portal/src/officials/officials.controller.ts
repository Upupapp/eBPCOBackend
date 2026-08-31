import { Controller, Get } from '@nestjs/common';

import { OfficialListResponse } from '../http/contract';
import { OfficialsRepository } from './officials.repository';
import { POLICIES, Cacheable } from '../http/cache';

@Controller('officials')
export class OfficialsController {
  constructor(private readonly officials: OfficialsRepository) {}

  @Cacheable(POLICIES.reference, () => 'officials')
  @Get()
  async list(): Promise<OfficialListResponse> {
    return { officials: await this.officials.list() };
  }
}
