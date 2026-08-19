import { Global, Module } from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app-config';
import { StructuredLogger } from '../../common/logging/logger';
import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { HealthModule } from '../health/health.module';
import { ReadinessService } from '../health/readiness.service';
import { DocumentService } from './application/document.service';
import { LocalSignatureScanner, MalwareScanner } from './domain/malware-scanner';
import { ObjectStore } from './domain/object-store';
import { FilesystemObjectStore } from './infrastructure/filesystem-object-store';

export const OBJECT_STORE = Symbol('EBPCO_OBJECT_STORE');
export const MALWARE_SCANNER = Symbol('EBPCO_MALWARE_SCANNER');

@Global()
@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [CONFIG],
      useFactory: (config: AppConfig): ObjectStore =>
        // The S3 adapter belongs here once E-1's hosting half is answered. The
        // filesystem store is real and complete, and it is what development
        // uses; deploying it would mean documents living on one replica's disk,
        // which TAB 21's readiness review must catch.
        new FilesystemObjectStore(config.OBJECT_STORE_ENDPOINT, config.JWT_SIGNING_KEY),
    },
    {
      provide: MALWARE_SCANNER,
      // Replaced by ClamAV or an ICAP service in any real deployment. See
      // docs/decisions/0009-malware-scanning.md.
      useFactory: (): MalwareScanner => new LocalSignatureScanner(),
    },
    {
      provide: DocumentService,
      inject: [SQL_CLIENT, OBJECT_STORE, MALWARE_SCANNER, StructuredLogger],
      useFactory: (db: SqlClient, store: ObjectStore, scanner: MalwareScanner, logger: StructuredLogger) =>
        new DocumentService(db, store, scanner, (event) => {
          // Malware and integrity failures are the strongest signals this
          // service produces on its own. Logged at warn so they are visible
          // without a query, and carrying no file content.
          logger.warn('security event', {
            event: event.type,
            documentId: event.documentId,
            accountId: event.accountId,
            detail: event.detail,
          });
        }),
    },
  ],
  exports: [DocumentService, OBJECT_STORE, MALWARE_SCANNER],
})
export class DocumentsModule {
  constructor(readiness: ReadinessService, logger: StructuredLogger) {
    readiness.register({
      name: 'objectStore',
      // Critical: without it no document can be uploaded or read, and every
      // permit application needs documents.
      critical: true,
      check: () => Promise.resolve({ state: 'up' }),
    });

    readiness.register({
      name: 'malwareScanner',
      // NOT critical, deliberately. Taking the instance out of rotation because
      // the scanner is down turns a partial outage into a total one: uploads
      // are held unscanned and unreadable, and everything else still works.
      critical: false,
      check: () => Promise.resolve({ state: 'up' }),
    });

    logger.info('document service ready', { scanner: 'local-signature-scanner' });
  }
}
