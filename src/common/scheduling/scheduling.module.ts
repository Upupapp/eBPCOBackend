import { Inject, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';

import { AppConfig, CONFIG } from '../../config/app-config';
import { StructuredLogger } from '../logging/logger';
import { DRAIN_STATE, SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { DrainState } from '../lifecycle/shutdown';
import { AuditService } from '../../modules/compliance/application/audit.service';
import { DataExportService } from '../../modules/compliance/application/data-export.service';
import { ComplianceModule } from '../../modules/compliance/compliance.module';
import { DocumentService } from '../../modules/documents/application/document.service';
import { NotificationService } from '../../modules/notifications/application/notification.service';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { Job, JobRunner } from './job-runner';
import { Scheduler } from './scheduler';
import {
  auditVerificationJob, dataExportExpiryJob, dataExportJob,
  notificationDispatchJob, operationalPurgeJob, retentionJob,
} from './jobs';

export const JOB_RUNNER = Symbol('EBPCO_JOB_RUNNER');
export const SCHEDULER = Symbol('EBPCO_SCHEDULER');

/**
 * Periodic work, started with the process and stopped before it drains.
 *
 * Every replica runs a scheduler and they coordinate through the database, so
 * there is no separate worker deployment to operate, no leader election, and no
 * coordinator to be down. The cost is one small UPDATE per job per tick, which
 * is the right trade for a service this size.
 *
 * A dedicated worker becomes the better answer when a job is long enough that
 * it should not share a pool with requests an applicant is waiting on. Nothing
 * here is yet.
 */
@Module({
  imports: [ComplianceModule, NotificationsModule],
  providers: [
    {
      provide: JOB_RUNNER,
      inject: [SQL_CLIENT, StructuredLogger],
      useFactory: (db: SqlClient, logger: StructuredLogger): JobRunner =>
        // The hostname is the pod name under an orchestrator, which is what an
        // operator needs to find the replica that is holding a job.
        new JobRunner(db, logger, hostname()),
    },
    {
      provide: SCHEDULER,
      inject: [
        JOB_RUNNER, SQL_CLIENT, StructuredLogger, DRAIN_STATE, CONFIG,
        DocumentService, AuditService, NotificationService, DataExportService,
      ],
      useFactory: (
        runner: JobRunner, db: SqlClient, logger: StructuredLogger, drain: DrainState,
        config: AppConfig, documents: DocumentService, audit: AuditService,
        notifications: NotificationService, dataExports: DataExportService,
      ): Scheduler => {
        const jobs: Job[] = [
          retentionJob(documents, config.DOCUMENT_RETENTION_DAYS),
          auditVerificationJob(audit, logger),
          notificationDispatchJob(notifications),
          operationalPurgeJob(db),
          dataExportJob(dataExports, db),
          dataExportExpiryJob(dataExports),
        ];
        return new Scheduler(runner, jobs, logger, drain, config.SCHEDULER_TICK_SECONDS);
      },
    },
  ],
  exports: [JOB_RUNNER, SCHEDULER],
})
export class SchedulingModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.SCHEDULER_ENABLED) {
      // Off in tests, and available as an escape hatch: a job misbehaving in
      // production should be stoppable without a deploy. The per-job `enabled`
      // column is the finer control; this is the whole-instance one.
      this.logger.info('scheduler disabled by configuration');
      return;
    }
    this.scheduler.start();
  }

  onApplicationShutdown(): void {
    this.scheduler.stop();
  }
}
