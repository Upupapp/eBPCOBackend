import { Principal } from './identity.service';

export type Decision =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

/**
 * 'May confirm, but not a proposal they authored.'
 *
 * TAB 11 requires this rule live in the authorisation layer rather than being
 * scattered through handlers, and the reason is concrete: the four-eyes rule
 * exists to stop ONE person changing a fact about a real person unilaterally,
 * and a rule re-implemented per handler is a rule that is eventually missed in
 * one of them.
 *
 * The domain ALSO refuses this, in ConfirmationService. That duplication is
 * deliberate — the workflow must hold even when invoked outside HTTP, and this
 * layer must refuse before a handler is entered. Two independent checks of one
 * rule is defence; one check reached by two paths is a hope.
 */
export function mayConfirm(principal: Principal, proposedBy: string): Decision {
  if (!principal.scopes.includes('content:confirm')) {
    return {
      permitted: false,
      reason: `The ${principal.role} role does not grant content:confirm.`,
    };
  }
  if (proposedBy.trim().toLowerCase() === principal.email.trim().toLowerCase()) {
    return {
      permitted: false,
      reason: 'A proposal must be confirmed by someone other than the person who made it.',
    };
  }
  return { permitted: true };
}
