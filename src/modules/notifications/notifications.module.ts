import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { NotificationService } from './application/notification.service';
import { NotificationsController } from './transport/notifications.controller';
import { StaffNotificationService } from './application/staff-notification.service';
import { StaffNotificationsController } from './transport/staff-notifications.controller';
import { StructuredLogger } from '../../common/logging/logger';
import { AppConfig, CONFIG } from '../../config/app-config';
import { SecretBox } from '../identity/domain/secret-box';

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
      // One box, built once from the key. Constructing it per request would
      // re-derive the key material on every device registration for no gain.
      provide: SecretBox,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => new SecretBox(config.PUSH_TOKEN_ENCRYPTION_KEY),
    },
    {
      provide: StaffNotificationService,
      inject: [SQL_CLIENT, StructuredLogger],
      useFactory: (db: SqlClient, logger: StructuredLogger) =>
        new StaffNotificationService(db, (status, roles) =>
          // An application sitting in a queue with nobody to work it. The LGU
          // has to be told; the applicant's clock is running either way.
          logger.warn('no officer holds the role this application was routed to', {
            status, roles,
          })),
    },
    {
      provide: NotificationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new NotificationService(db),
    },
  ],
  controllers: [NotificationsController, StaffNotificationsController],
  exports: [NotificationService, StaffNotificationService],
})
export class NotificationsModule {}
