import { Module } from '@nestjs/common';

import { PagesController } from './pages.controller';
import { PagesRepository } from './pages.repository';
import { PagesService } from './pages.service';

@Module({
  controllers: [PagesController],
  providers: [PagesRepository, PagesService],
  exports: [PagesRepository, PagesService],
})
export class PagesModule {}
