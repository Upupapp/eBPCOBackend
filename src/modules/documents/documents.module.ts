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
import { DocumentsController } from './transport/documents.controller';
import { AuditService } from '../compliance/application/audit.service';
import { documentSecurityEvent } from '../compliance/domain/security-events';
import { S3ObjectStore, s3ClientFor } from './infrastructure/s3-object-store';

export const OBJECT_STORE = Symbol('EBPCO_OBJECT_STORE');
export const MALWARE_SCANNER = Symbol('EBPCO_MALWARE_SCANNER');

@Global()
@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [CONFIG],
      useFactory: objectStoreFor,
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

          // And recorded, since D-6. Malware in an upload and an unauthorised
          // document read are accountability records, not telemetry: they name
          // an account and a file, and an investigator needs them to survive
          // the container that produced them.
          //
          // Fire-and-forget: refusing an infected upload must not depend on an
          // audit write succeeding.
          void new AuditService(db)
            .append(documentSecurityEvent(
              event.accountId ?? null, event.documentId ?? null, event.type, event.detail,
            ))
            .catch((cause: unknown) => logger.error('security event not recorded', {
              event: event.type,
              reason: cause instanceof Error ? cause.message : String(cause),
            }));
        }),
    },
  ],
  controllers: [DocumentsController],
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

/**
 * Which store the service runs on.
 *
 * Exported and named rather than an inline factory, because an inline factory
 * is unreachable from a test: a break-check that pointed this branch at the
 * filesystem store while the driver said `s3` passed the whole suite. Wiring
 * that nothing can observe is the defect this repository keeps finding.
 */
export function objectStoreFor(config: AppConfig): ObjectStore {
  if (config.OBJECT_STORE_DRIVER === 's3') {
    // Credentials come from the SDK's default chain -- an instance role, or the
    // standard AWS_* variables -- and deliberately not from this service's own
    // configuration. A storage secret that never enters `.env.example` is one
    // that cannot be committed by accident.
    return new S3ObjectStore(
      s3ClientFor({
        endpoint: config.OBJECT_STORE_ENDPOINT,
        region: config.OBJECT_STORE_REGION,
      }),
      config.OBJECT_STORE_BUCKET,
      config.JWT_SIGNING_KEY,
      config.OBJECT_STORE_PUBLIC_PROBE_URL.length > 0
        ? config.OBJECT_STORE_PUBLIC_PROBE_URL
        : null,
    );
  }

  // OBJECT_STORE_LOCAL_PATH, not OBJECT_STORE_ENDPOINT. The endpoint is the S3
  // adapter's setting, and passing it here wrote every uploaded document into a
  // directory literally named after a URL.
  //
  // Production refuses to boot on this branch -- see app-config -- so reaching
  // it means development, or a staging environment somebody chose it for.
  return new FilesystemObjectStore(config.OBJECT_STORE_LOCAL_PATH, config.JWT_SIGNING_KEY);
}
