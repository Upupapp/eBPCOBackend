import { INestApplication } from '@nestjs/common';

export interface Route {
  readonly method: string;
  /** OpenAPI form: `/offices/{slug}`, not Fastify's `/offices/:slug`. */
  readonly path: string;
}

/**
 * Every route the application actually serves.
 *
 * Read out of Fastify's own router rather than from a list somebody maintains,
 * because the whole point of the parity check is to catch the route nobody
 * remembered to write down.
 *
 * `commonPrefix: false` is essential: the default output is radix-compressed
 * ('offic' branching to 'es' and 'ials'), which cannot be reassembled into
 * paths. The flat form still nests children as suffixes of their parent, so the
 * depth stack below rebuilds the full path.
 */
export function routesOf(app: INestApplication): Route[] {
  const printed = (app.getHttpAdapter().getInstance() as {
    printRoutes: (options?: { commonPrefix?: boolean }) => string;
  }).printRoutes({ commonPrefix: false });

  const routes: Route[] = [];
  const prefixes: string[] = [];

  for (const line of printed.split('\n')) {
    const match = /^([\s│├└─]*)(\S+)(?:\s+\((.+)\))?$/.exec(line);
    if (match === null) continue;

    const glyphs = match[1] ?? '';
    const segment = match[2] ?? '';
    const methods = match[3];
    if (!segment.startsWith('/')) continue;

    // Four characters of tree glyph per level.
    const depth = Math.floor(glyphs.length / 4);
    prefixes.length = depth;
    const full = (prefixes.join('') + segment).replace(/\/+/g, '/');
    prefixes.push(segment);

    if (methods === undefined) continue;
    for (const method of methods.split(',').map((m) => m.trim())) {
      // HEAD is Fastify's automatic companion to GET and is not a separate
      // contract entry; documenting it would double every path for nothing.
      if (method === '' || method === 'HEAD') continue;
      routes.push({ method, path: full.replace(/:([A-Za-z]+)/g, '{$1}') });
    }
  }
  return routes;
}
