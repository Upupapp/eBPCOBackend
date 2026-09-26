import { RouteConfig } from '@nestjs/platform-fastify';

/**
 * Marks a route that carries a file as base64 in its JSON body.
 *
 * Such a route gets `UPLOAD_BODY_LIMIT_BYTES` instead of `BODY_LIMIT_BYTES`,
 * and `UPLOAD_TIMEOUT_MS` instead of `REQUEST_TIMEOUT_MS` (security.ts). Every
 * other route keeps the small JSON limits, so raising what a file may weigh
 * does not raise what any other request may.
 *
 * A marker on the handler rather than a list of paths in the bootstrap: a
 * list is a second place to keep in step with the controllers, and the route
 * that falls out of it gets the 1MB limit back without anyone noticing.
 */
export const UploadRoute = (): MethodDecorator => RouteConfig({ upload: true });

/** Whether a Fastify route's `config` is an upload route's. */
export function isUploadRoute(config: unknown): boolean {
  return typeof config === 'object' && config !== null && (config as { upload?: unknown }).upload === true;
}
