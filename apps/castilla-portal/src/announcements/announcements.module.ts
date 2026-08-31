import { Module } from '@nestjs/common';

import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsStaffController } from './announcements.staff.controller';
import { AnnouncementsRepository } from './announcements.repository';
import { AnnouncementsService } from './announcements.service';

@Module({
  controllers: [AnnouncementsController, AnnouncementsStaffController],
  // The service is provided and exported but has NO controller: the lifecycle
  // is domain logic waiting for TAB 11's authentication, not a public route.
  providers: [AnnouncementsRepository, AnnouncementsService],
  exports: [AnnouncementsRepository, AnnouncementsService],
})
export class AnnouncementsModule {}
