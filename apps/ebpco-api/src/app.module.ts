import { Module } from '@nestjs/common';

import { AppConfig, CONFIG } from './config/app-config';
import { StructuredLogger } from './common/logging/logger';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PermitsModule } from './modules/permits/permits.module';
import { SchedulingModule } from './common/scheduling/scheduling.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BusinessesModule } from './modules/businesses/businesses.module';
import { PersistenceModule, SQL_CLIENT_OVERRIDE } from './persistence/persistence.module';
import { SqlClient } from './persistence/sql-client';

/**
 * The composition root.
 *
 * Layering is enforced by module boundaries rather than by convention:
 * transport (controllers) may depend on application services, application
 * services on the domain, and the domain on nothing. A lifecycle rule that
 * ends up in a controller is a rule the next transport cannot reuse and no
 * unit test can reach without an HTTP request.
 */
@Module({})
export class AppModule {
  static forConfig(config: AppConfig, logger: StructuredLogger, sqlClientOverride?: SqlClient) {
    return {
      module: AppModule,
      imports: [
        HealthModule, PersistenceModule, IdentityModule, DocumentsModule,
        ApplicationsModule, PaymentsModule, PermitsModule,
        ComplianceModule, NotificationsModule, BusinessesModule, SchedulingModule,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: StructuredLogger, useValue: logger },
        { provide: SQL_CLIENT_OVERRIDE, useValue: sqlClientOverride ?? null },
      ],
      exports: [CONFIG, StructuredLogger, SQL_CLIENT_OVERRIDE],
      global: true,
    };
  }
}
