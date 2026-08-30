import { DynamicModule, Module } from '@nestjs/common';

import { MunicipalityModule } from './municipality/municipality.module';
import { OfficesModule } from './offices/offices.module';
import { OfficialsModule } from './officials/officials.module';
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
      imports: [OfficesModule, OfficialsModule, MunicipalityModule],
      providers: [{ provide: SQL_CLIENT, useValue: db }],
      exports: [SQL_CLIENT],
      // Global because every feature module needs the same connection and
      // threading a Database module through each import list adds ceremony
      // without adding a decision.
      global: true,
    };
  }
}
