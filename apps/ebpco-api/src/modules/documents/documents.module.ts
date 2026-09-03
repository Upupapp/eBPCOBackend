import { Global, Inject, Module, OnApplicationBootstrap } from '@nestjs/common';

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
import { LimitsController } from './transport/limits.controller';
import { AuditService } from '../compliance/application/audit.service';
import { documentSecurityEvent } from '../compliance/domain/security-events';
import { S3ObjectStore, s3ClientFor } from './infrastructure/s3-object-store';
import { ClamAvScanner, clamAvAddress } from './infrastructure/clamav-scanner';

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
      inject: [CONFIG],
      useFactory: malwareScannerFor,
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
  controllers: [DocumentsController, LimitsController],
  exports: [DocumentService, OBJECT_STORE, MALWARE_SCANNER],
})
export class DocumentsModule implements OnApplicationBootstrap {
  /**
   * Whether the bucket answered a stranger, probed ONCE at startup.
   *
   * Once, not per probe: the readiness endpoint is polled continuously, and an
   * outbound anonymous request per poll would be a request per second against
   * the bucket forever. The port's own words are "checked on every deploy",
   * and a process start is a deploy.
   *
   * `null` until the probe has run. Reported as `up` in that window rather than
   * down -- refusing traffic during the first seconds of every start would turn
   * a check into an outage.
   */
  private bucketIsPublic: boolean | null = null;

  constructor(
    private readonly readiness: ReadinessService,
    private readonly logger: StructuredLogger,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {
    this.readiness.register({
      name: 'objectStore',
      // Critical: without it no document can be uploaded or read, and every
      // permit application needs documents.
      critical: true,
      check: () => Promise.resolve(
        this.bucketIsPublic === true
          ? {
            state: 'down' as const,
            detail: 'the document bucket answered an anonymous request. Applicants\' identity '
              + 'documents are readable by anyone who can guess a key; this instance will not '
              + 'serve until the bucket is made private.',
          }
          : { state: 'up' as const },
      ),
    });

    this.readiness.register({
      name: 'malwareScanner',
      // NOT critical, deliberately. Taking the instance out of rotation because
      // the scanner is down turns a partial outage into a total one: uploads
      // are held unscanned and unreadable, and everything else still works.
      critical: false,
      check: async () => (await this.scanner.isReachable()
        ? { state: 'up' as const }
        : {
          // `down`, and non-critical, which the readiness service treats as
          // "reported but still serving" -- exactly the shape of this outage:
          // uploads are accepted and held, and nothing else is affected.
          state: 'down' as const,
          detail: `${this.scanner.name} is unreachable; uploads are being accepted and held `
            + 'unscanned rather than served or refused',
        }),
    });
  }

  /**
   * The public-bucket probe, at startup.
   *
   * Both readiness checks reported `state: 'up'` unconditionally until
   * 2026-08-30 -- they were placeholders that never called anything, so
   * `/ready` said the scanner and the store were healthy whatever was true of
   * them. `isPubliclyReadable` had no caller anywhere, despite the port saying
   * it is "checked on every deploy".
   */
  async onApplicationBootstrap(): Promise<void> {
    this.bucketIsPublic = await this.store.isPubliclyReadable();
    if (this.bucketIsPublic) {
      this.logger.error('the document bucket is readable without credentials', {
        consequence: 'applicants\' identity documents and land titles are exposed to anyone '
          + 'who can guess an object key; this instance is reporting itself NOT READY',
      });
    }

    this.logger.info('document service ready', {
      objectStore: this.store.constructor.name,
      scanner: this.scanner.name,
      scannerReachable: await this.scanner.isReachable(),
    });
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

/**
 * Which scanner the service runs on.
 *
 * Exported and named for the reason the object store's factory is: an inline
 * factory is unreachable from a test, and a break-check that pointed this at
 * the stub while the driver said `clamav` would pass the whole suite. A stub
 * that reports every file clean is not a thing to select by accident.
 */
export function malwareScannerFor(config: AppConfig): MalwareScanner {
  if (config.MALWARE_SCANNER_DRIVER === 'clamav') {
    const { host, port } = clamAvAddress(config.MALWARE_SCANNER_URL);
    return new ClamAvScanner(host, port);
  }

  // Production refuses to boot on this branch -- see app-config -- so reaching
  // it means development, or a staging environment somebody chose it for.
  return new LocalSignatureScanner();
}
