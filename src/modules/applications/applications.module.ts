import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { CalendarRepository, CachingCalendarRepository, SqlCalendarRepository }
  from '../compliance/application/calendar.repository';
import { PaymentsModule } from '../payments/payments.module';
import { PermitsModule } from '../permits/permits.module';
import { EvaluationService } from './application/evaluation.service';
import { LifecycleService } from './application/lifecycle.service';
import { ApplicantQueryService } from './application/applicant-query.service';
import { InstructionResponseService } from './application/instruction-response.service';
import { SubmissionService } from './application/submission.service';
import { RecordsService } from './application/records.service';
import { StaffQueueService } from './application/staff-queue.service';
import { StaffActionsController } from './transport/staff-actions.controller';
import { ApplicantApplicationsController } from './transport/applicant-applications.controller';
import { ApplicantWriteController } from './transport/applicant-write.controller';
import { StaffApplicationsController } from './transport/staff-applications.controller';
import { RequirementsService } from './application/requirements.service';
import { RequirementsController } from './transport/requirements.controller';
import { StaffEvaluationsController } from './transport/staff-evaluations.controller';
import { ReportsController } from '../compliance/transport/reports.controller';
import { CALENDAR_REPOSITORY } from '../compliance/application/calendar.repository';
import { WorkflowController } from './transport/workflow.controller';

// Re-exported where it used to be declared, so callers that reach for it here
// keep working. It now lives beside the port -- see calendar.repository.ts for
// why a token in a module is a cycle waiting to resolve to undefined.
export { CALENDAR_REPOSITORY };

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
  imports: [PaymentsModule, PermitsModule],
  providers: [
    {
      provide: CALENDAR_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient): CalendarRepository =>
        new CachingCalendarRepository(new SqlCalendarRepository(db)),
    },
    {
      provide: ApplicantQueryService,
      inject: [SQL_CLIENT, CALENDAR_REPOSITORY],
      useFactory: (db: SqlClient, calendars: CalendarRepository) =>
        new ApplicantQueryService(db, calendars),
    },
    {
      provide: InstructionResponseService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new InstructionResponseService(db),
    },
    {
      provide: RequirementsService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new RequirementsService(db),
    },
    {
      provide: RecordsService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new RecordsService(db),
    },
    {
      provide: SubmissionService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new SubmissionService(db),
    },
    {
      provide: StaffQueueService,
      inject: [SQL_CLIENT, CALENDAR_REPOSITORY, EvaluationService],
      useFactory: (db: SqlClient, calendars: CalendarRepository, evaluations: EvaluationService) =>
        new StaffQueueService(db, calendars, evaluations),
    },
    {
      provide: LifecycleService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new LifecycleService(db),
    },
    {
      provide: EvaluationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new EvaluationService(db),
    },
  ],
  controllers: [
    ApplicantApplicationsController, ApplicantWriteController,
    StaffApplicationsController, StaffActionsController, RequirementsController,
    StaffEvaluationsController,
    WorkflowController,
    // Compliance code, registered here because the calendar token it needs is
    // provided by this module. Moving the token would mean ComplianceModule
    // importing ApplicationsModule, and ComplianceModule is @Global and already
    // imported by identity — a cycle for the sake of tidier filing.
    ReportsController,
  ],
  exports: [StaffQueueService, LifecycleService, EvaluationService, CALENDAR_REPOSITORY],
})
export class ApplicationsModule {}
