import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfig, CONFIG } from '../../config/app-config';
import { StructuredLogger } from '../../common/logging/logger';
import { ACCOUNT_REPOSITORY, AccountRepository } from './application/account.repository';
import { IdentityService } from './application/identity.service';
import { SESSION_REPOSITORY, SessionRepository } from './application/session.repository';
import { TokenService } from './application/token.service';
import { PasswordHasher } from './domain/password-hasher';
import { PasswordPolicy } from './domain/password-policy';
import { PostgresAccountRepository } from './infrastructure/postgres-account.repository';
import { PostgresSessionRepository } from './infrastructure/postgres-session.repository';
import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { LocalBreachedPasswordScreen } from './infrastructure/breached-password-screen';
import { AuthController, MeController } from './transport/auth.controller';
import { AuthenticationGuard } from './transport/guards/authentication.guard';

/**
 * Identity, wired.
 *
 * The repositories are bound to their in-memory implementations here and
 * nowhere else, so TAB 04 swaps them for PostgreSQL by changing two lines
 * rather than by touching the domain. Everything above the port depends on the
 * interface and has never seen a database.
 */
@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [
    // Bound here and nowhere else. The in-memory implementations still exist,
    // and the shared contract suite holds both to identical behaviour, so
    // "works in tests, fails in production" surfaces as a failing test.
    {
      provide: ACCOUNT_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PostgresAccountRepository(db),
    },
    {
      provide: SESSION_REPOSITORY,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PostgresSessionRepository(db),
    },

    {
      provide: PasswordHasher,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => new PasswordHasher(undefined, config.PASSWORD_PEPPER),
    },
    {
      provide: PasswordPolicy,
      useFactory: () => new PasswordPolicy(new LocalBreachedPasswordScreen()),
    },
    {
      provide: TokenService,
      inject: [CONFIG, SESSION_REPOSITORY, StructuredLogger],
      useFactory: (config: AppConfig, sessions: SessionRepository, logger: StructuredLogger) =>
        new TokenService({
          signingKey: new TextEncoder().encode(config.JWT_SIGNING_KEY),
          sessions,
          onSecurityEvent: (event) => {
            // A replayed refresh token is the strongest signal of theft this
            // service can produce on its own. It is logged at warn so it is
            // visible without a query, and carries no credential material.
            logger.warn('security event', {
              event: event.type,
              accountId: event.accountId,
              familyId: event.familyId,
              detail: event.detail,
            });
          },
        }),
    },
    {
      provide: IdentityService,
      inject: [ACCOUNT_REPOSITORY, TokenService, PasswordHasher, PasswordPolicy],
      useFactory: (
        accounts: AccountRepository,
        tokens: TokenService,
        hasher: PasswordHasher,
        policy: PasswordPolicy,
      ) => new IdentityService(accounts, tokens, hasher, policy),
    },

    // Registered globally: a new controller is protected the moment it exists,
    // and opting out is a visible @Public() in the diff. A guard applied per
    // route fails open when someone forgets, and fails silently.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
  ],
  exports: [IdentityService, TokenService, ACCOUNT_REPOSITORY, SESSION_REPOSITORY],
})
export class IdentityModule {}
