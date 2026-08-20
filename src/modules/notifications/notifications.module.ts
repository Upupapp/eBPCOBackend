import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { NotificationService } from './application/notification.service';
import { NotificationsController } from './transport/notifications.controller';

/**
 * The applicant's feed, their preferences, and the plan for delivering each
 * notice.
 *
 * The controller serves the applicant's own feed, preferences and devices. What
 * does NOT live here is a transport: push, email and SMS all need a provider
 * that has not been chosen (E-1, M-27), and the scheduled job records planned
 * attempts so that whatever is chosen has a queue to read rather than a rewrite
 * to do.
 */
@Module({
  providers: [
    {
      provide: NotificationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new NotificationService(db),
    },
  ],
  controllers: [NotificationsController],
  exports: [NotificationService],
})
export class NotificationsModule {}
