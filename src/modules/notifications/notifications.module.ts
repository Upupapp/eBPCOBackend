import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { NotificationService } from './application/notification.service';

/**
 * The applicant's feed, their preferences, and the plan for delivering each
 * notice.
 *
 * No transport lives here yet, and that is the point of the module existing
 * before it does: push, email and SMS all need a provider that has not been
 * chosen (E-1, M-27), and the scheduled job records planned attempts so that
 * whatever is chosen has a queue to read rather than a rewrite to do.
 */
@Module({
  providers: [
    {
      provide: NotificationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new NotificationService(db),
    },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
