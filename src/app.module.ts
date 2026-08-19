import { Module } from '@nestjs/common';

import { AppConfig, CONFIG } from './config/app-config';
import { StructuredLogger } from './common/logging/logger';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';

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
  static forConfig(config: AppConfig, logger: StructuredLogger) {
    return {
      module: AppModule,
      imports: [HealthModule, IdentityModule],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: StructuredLogger, useValue: logger },
      ],
      exports: [CONFIG, StructuredLogger],
      global: true,
    };
  }
}
