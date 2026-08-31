import { Module } from '@nestjs/common';

import { FormsController } from './forms.controller';
import { FormsRepository } from './forms.repository';

@Module({
  controllers: [FormsController],
  providers: [FormsRepository],
  exports: [FormsRepository],
})
export class FormsModule {}
