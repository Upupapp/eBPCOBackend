import { Module } from '@nestjs/common';

import { PermitsController } from './permits.controller';
import { PermitsRepository } from './permits.repository';

@Module({
  controllers: [PermitsController],
  providers: [PermitsRepository],
  exports: [PermitsRepository],
})
export class PermitsModule {}
