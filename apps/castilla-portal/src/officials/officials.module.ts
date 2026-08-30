import { Module } from '@nestjs/common';

import { OfficialsController } from './officials.controller';
import { OfficialsRepository } from './officials.repository';

@Module({
  controllers: [OfficialsController],
  providers: [OfficialsRepository],
  exports: [OfficialsRepository],
})
export class OfficialsModule {}
