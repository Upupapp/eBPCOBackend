import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { AssessmentService } from './application/assessment.service';
import { PaymentService } from './application/payment.service';
import { StaffPaymentsController } from './transport/staff-payments.controller';

/**
 * Orders of Payment, and proof that money arrived.
 *
 * The SqlClient is provided to the controller directly for the queue read
 * only. That is a deliberate, narrow exception: the queue is a projection for
 * one screen with no rule attached to it, and inventing a service whose sole
 * method is one SELECT adds a layer without adding a decision. Anything that
 * decides something goes through PaymentService, where the separation-of-duty
 * rule lives.
 */
@Module({
  providers: [
    {
      provide: AssessmentService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new AssessmentService(db),
    },
    {
      provide: PaymentService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PaymentService(db),
    },
  ],
  controllers: [StaffPaymentsController],
  exports: [AssessmentService, PaymentService],
})
export class PaymentsModule {}
