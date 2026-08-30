import { Controller, Get } from '@nestjs/common';

import { MunicipalityProfileResponse } from '../http/contract';
import { MunicipalityRepository } from './municipality.repository';

@Controller('municipality')
export class MunicipalityController {
  constructor(private readonly municipality: MunicipalityRepository) {}

  @Get('profile')
  async profile(): Promise<MunicipalityProfileResponse> {
    return { fields: await this.municipality.profile() };
  }
}
