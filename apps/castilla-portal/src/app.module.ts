import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AnnouncementsModule } from './announcements/announcements.module';
import { FormsModule } from './forms/forms.module';
import { AuthGuard } from './identity/auth.guard';
import { IdentityModule } from './identity/identity.module';
import { SessionController } from './identity/session.controller';
import { MunicipalityModule } from './municipality/municipality.module';
import { OfficesModule } from './offices/offices.module';
import { OfficialsModule } from './officials/officials.module';
import { PagesModule } from './pages/pages.module';
import { PermitsModule } from './permits/permits.module';
import { SearchModule } from './search/search.module';
import { WorkflowModule } from './workflow/workflow.module';
import { SQL_CLIENT, SqlClient } from './persistence/sql-client';

/**
 * Composed around a SqlClient supplied by the caller.
 *
 * The database is an argument rather than something this module constructs,
 * so the tests exercise the SAME composition production uses — the wiring is
 * covered, not just the pieces. A module that built its own pool would leave
 * the one thing most likely to be wrong as the one thing never tested.
 */
@Module({})
export class AppModule {
  static withDatabase(db: SqlClient): DynamicModule {
    return {
      module: AppModule,
      imports: [
        OfficesModule, OfficialsModule, MunicipalityModule, PermitsModule, FormsModule,
        IdentityModule,
        AnnouncementsModule, SearchModule, PagesModule, WorkflowModule,
      ],
      controllers: [SessionController],
      providers: [
        { provide: SQL_CLIENT, useValue: db },
        // The guard is APP_GUARD, so it runs for every route in every module.
        // Registering it per-controller would mean a new controller is
        // unguarded by default, and 'someone forgot the decorator' is exactly
        // how a write endpoint ends up public.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [SQL_CLIENT],
      // Global because every feature module needs the same connection and
      // threading a Database module through each import list adds ceremony
      // without adding a decision.
      global: true,
    };
  }
}
