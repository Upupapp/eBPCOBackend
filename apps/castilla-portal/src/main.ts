import 'reflect-metadata';

import compress from '@fastify/compress';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';

import { AppModule } from './app.module';

/**
 * The production bootstrap.
 *
 * It exists so the composition the tests exercise is the composition that runs:
 * `AppModule.withDatabase` is called here with a real pool and in the harness
 * with PGlite, and nothing else differs. A service whose only wiring lives in
 * its tests is a service whose wiring has never been run.
 */
async function bootstrap(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    // Fail loudly at boot rather than on the first request. A portal that
    // starts and then 500s every page is harder to diagnose than one that
    // never starts.
    throw new Error('DATABASE_URL is not set');
  }

  const pool = new Pool({ connectionString });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.withDatabase(pool), new FastifyAdapter(),
  );
  // Compression for JSON, and NOT for the bundled forms.
  //
  // A PDF is already deflate-compressed internally: gzipping it again spends
  // CPU to make the file marginally larger, and TAB 06's download must serve
  // the LGU's bytes rather than a re-encoded approximation of them.
  await app.register(compress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'],
    customTypes: /^(?:application\/(?:json|problem\+json)|text\/)/,
  });

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
