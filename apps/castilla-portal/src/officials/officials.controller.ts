import { Controller, Get } from '@nestjs/common';

import { OfficialListResponse } from '../http/contract';
import { OfficialsRepository } from './officials.repository';

@Controller('officials')
export class OfficialsController {
  constructor(private readonly officials: OfficialsRepository) {}

  @Get()
  async list(): Promise<OfficialListResponse> {
    return { officials: await this.officials.list() };
  }
}
