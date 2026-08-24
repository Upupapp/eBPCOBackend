import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { AuditService } from './application/audit.service';
import { ErasureService } from './application/erasure.service';
import { DataExportService } from './application/data-export.service';
import { OBJECT_STORE } from '../documents/documents.module';
import { ObjectStore } from '../documents/domain/object-store';

/**
 * The chained audit trail, and the data-subject rights that read and write it.
 *
 * `AuditService` was constructed inline by every service that appends to it,
 * which was fine while nothing else needed one — and stopped being fine the
 * moment a scheduled job had to VERIFY the chain rather than append to it.
 * Provided here so there is one place that owns it.
 *
 * Global, because every module writes audit entries and threading an import
 * through each of them would make the audit trail look like an optional
 * dependency of the things it is meant to hold to account.
 */
@Module({
  providers: [
    {
      provide: AuditService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new AuditService(db),
    },
    {
      provide: DataExportService,
      inject: [SQL_CLIENT, OBJECT_STORE],
      useFactory: (db: SqlClient, store: ObjectStore) => new DataExportService(db, store),
    },
    {
      provide: ErasureService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new ErasureService(db),
    },
  ],
  exports: [AuditService, ErasureService, DataExportService],
})
export class ComplianceModule {}
