import { Module } from '@nestjs/common';

import { OfficesController } from './offices.controller';
import { OfficesRepository } from './offices.repository';

@Module({
  controllers: [OfficesController],
  providers: [OfficesRepository],
  exports: [OfficesRepository],
})
export class OfficesModule {}
