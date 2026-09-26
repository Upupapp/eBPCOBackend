import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { NotificationService } from './application/notification.service';
import { PushDeliveryService } from './application/push-delivery.service';
import { FcmSender } from './infrastructure/fcm-sender';
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
 * The controller serves the applicant's own feed, preferences and devices. Push
 * is sent through Firebase Cloud Messaging (PushDeliveryService); email and SMS
 * still need a provider (E-1, M-27), so their planned attempts stay queued for
 * whichever is chosen.
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
    {
      // Push over FCM. Null sender when FCM_SERVICE_ACCOUNT_JSON_BASE64 is
      // unset: attempts keep queueing and the dispatch job reports NOT SENT.
      provide: PushDeliveryService,
      inject: [SQL_CLIENT, SecretBox, CONFIG],
      useFactory: (db: SqlClient, tokens: SecretBox, config: AppConfig) =>
        new PushDeliveryService(db, tokens, FcmSender.fromBase64(config.FCM_SERVICE_ACCOUNT_JSON_BASE64)),
    },
  ],
  controllers: [NotificationsController, StaffNotificationsController],
  exports: [NotificationService, StaffNotificationService, PushDeliveryService],
})
export class NotificationsModule {}
