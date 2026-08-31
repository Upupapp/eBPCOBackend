import { Global, Module } from '@nestjs/common';

import { AuthGuard } from './auth.guard';
import { IdentityService } from './identity.service';

/**
 * Global so every feature module can guard a route without importing identity,
 * which is the arrangement least likely to leave a route unguarded because
 * someone forgot an import.
 */
@Global()
@Module({
  providers: [IdentityService, AuthGuard],
  exports: [IdentityService, AuthGuard],
})
export class IdentityModule {}
