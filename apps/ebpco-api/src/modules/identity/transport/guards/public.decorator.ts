import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as reachable without a token.
 *
 * The allow-list is expressed as an explicit mark on the route rather than as a
 * list of paths held somewhere else, so adding an endpoint cannot accidentally
 * make it public and a reviewer sees the decision in the diff, next to the
 * handler it applies to.
 */
export const IS_PUBLIC = 'ebpco:public';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** The scopes a caller must hold. Absent means "authenticated is enough". */
export const REQUIRED_SCOPES = 'ebpco:scopes';

export const RequireScopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);
