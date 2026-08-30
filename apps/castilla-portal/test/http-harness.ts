import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { INestApplication } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PGlite } from '@electric-sql/pglite';

import { AppModule } from '../src/app.module';
import { migrate } from '../src/persistence/migrator';
import { Seeder } from '../src/seed/seeder';
import { ExtractedPortalData } from '../src/seed/extracted';

export interface Harness {
  app: INestApplication;
  db: PGlite;
  get(url: string): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/**
 * A real Fastify server over a real PostgreSQL, both in-process.
 *
 * `app.inject` rather than a socket: it runs the entire request pipeline —
 * routing, param binding, serialisation, exception filters — which is where
 * the withheld-field rules actually have to hold. Serialisation in particular
 * is the step that decides whether an absent key is absent or `null`, and a
 * repository unit test cannot see it.
 */
export async function harness(): Promise<Harness> {
  const db = await PGlite.create();
  await migrate(db, join(__dirname, '../db/migrations'));
  const data = JSON.parse(
    readFileSync(join(__dirname, '../contract/portal-data.json'), 'utf8'),
  ) as ExtractedPortalData;
  await new Seeder(db).run(data);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.withDatabase(db)],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    db,
    async get(url: string) {
      const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url });
      return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
