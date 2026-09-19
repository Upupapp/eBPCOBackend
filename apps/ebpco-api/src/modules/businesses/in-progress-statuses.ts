import { LIFECYCLE_STATUSES, isTerminal } from '../applications/domain/lifecycle';

/**
 * Every lifecycle status that means the LGU still has work in progress
 * against an application — the set a business's deactivate route (citizen
 * or staff) refuses to leave stranded. Shared so the citizen and staff
 * businesses controllers cannot drift on what "in progress" means.
 */
export const IN_PROGRESS_STATUSES = LIFECYCLE_STATUSES.filter((status) => !isTerminal(status));
