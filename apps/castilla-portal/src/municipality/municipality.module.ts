import { Module } from '@nestjs/common';

import { MunicipalityController } from './municipality.controller';
import { MunicipalityRepository } from './municipality.repository';

@Module({
  controllers: [MunicipalityController],
  providers: [MunicipalityRepository],
  exports: [MunicipalityRepository],
})
export class MunicipalityModule {}
