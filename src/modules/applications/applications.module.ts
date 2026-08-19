import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { CalendarRepository, CachingCalendarRepository, SqlCalendarRepository }
  from '../compliance/application/calendar.repository';
import { LifecycleService } from './application/lifecycle.service';
import { StaffQueueService } from './application/staff-queue.service';
import { StaffApplicationsController } from './transport/staff-applications.controller';

export const CALENDAR_REPOSITORY = Symbol('EBPCO_CALENDAR_REPOSITORY');

/**
 * The application lifecycle, and the officer's view of it.
 *
 * The calendar repository is provided here rather than constructed inside the
 * queue service so that both this module and the compliance report read the
 * same instance — one cache, one answer about whether a given day was a working
 * day. Two caches would eventually disagree during the minutes after a
 * proclamation is loaded, and the disagreement would be about whether an LGU
 * met a statutory deadline.
 */
@Module({
  providers: [
    {
      provide: CALENDAR_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient): CalendarRepository =>
        new CachingCalendarRepository(new SqlCalendarRepository(db)),
    },
    {
      provide: StaffQueueService,
      inject: [SQL_CLIENT, CALENDAR_REPOSITORY],
      useFactory: (db: SqlClient, calendars: CalendarRepository) =>
        new StaffQueueService(db, calendars),
    },
    {
      provide: LifecycleService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new LifecycleService(db),
    },
  ],
  controllers: [StaffApplicationsController],
  exports: [StaffQueueService, LifecycleService, CALENDAR_REPOSITORY],
})
export class ApplicationsModule {}
