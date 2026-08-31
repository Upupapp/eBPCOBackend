import { Controller, Get } from '@nestjs/common';

import { MunicipalityProfileResponse } from '../http/contract';
import { MunicipalityRepository } from './municipality.repository';
import { POLICIES, Cacheable } from '../http/cache';

@Controller('municipality')
export class MunicipalityController {
  constructor(private readonly municipality: MunicipalityRepository) {}

  @Cacheable(POLICIES.reference, () => 'municipality')
  @Get('profile')
  async profile(): Promise<MunicipalityProfileResponse> {
    return { fields: await this.municipality.profile() };
  }
}
