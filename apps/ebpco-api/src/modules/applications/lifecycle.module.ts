import { Global, Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { LifecycleService } from './application/lifecycle.service';
import { StaffNotificationService } from '../notifications/application/staff-notification.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * `LifecycleService` alone, split out of `ApplicationsModule`.
 *
 * `StaffPaymentsController` (PaymentsModule) needs it too, to advance
 * `Payment Submitted -> Payment Under Verification -> Payment Verified`
 * after a payment is confirmed -- the same "the payments table moved but the
 * application didn't" gap that `recordOnsite`/`pay` were patched for, on the
 * one route neither of those patches could reach. `ApplicationsModule`
 * already imports `PaymentsModule` (for `PaymentService`), so `PaymentsModule`
 * importing `ApplicationsModule` back for this one service would be the same
 * cycle `DocumentsModule` was kept out of for its own reasons (see
 * `documents.controller.ts`'s ownership-check comment). `@Global()` here,
 * rather than `forwardRef()`, matches how this codebase has already resolved
 * this exact shape of problem for `ComplianceModule`/`DocumentsModule`.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [
    {
      provide: LifecycleService,
      // The module's StaffNotificationService, not one built here -- see
      // the identical note this factory carried in applications.module.ts.
      inject: [SQL_CLIENT, StaffNotificationService],
      useFactory: (db: SqlClient, staffNotices: StaffNotificationService) =>
        new LifecycleService(db, () => new Date(), undefined, staffNotices),
    },
  ],
  exports: [LifecycleService],
})
export class LifecycleModule {}
