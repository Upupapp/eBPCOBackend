import { Controller, Get } from '@nestjs/common';

import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import { ROLE_SCOPES } from '../../identity/domain/account';
import {
  LIFECYCLE_STATUSES, TRANSITIONS, applicantStatusOf, isTerminal, pledgeApplies,
  requiresApplicantAction, rolesGranting,
} from '../domain/lifecycle';

/**
 * The lifecycle, as the server enforces it.
 *
 * ── Read-only, and that is the whole decision ───────────────────────────
 *
 * The portal draws a flow chart from a copy of this compiled into the client.
 * Serving it means the picture an officer sees is the rule the server actually
 * applies, rather than a second statement of it that was true when someone
 * typed it.
 *
 * Making it EDITABLE is a much larger thing and deliberately not done here.
 * The transition table is enforced in the database as well as the service, and
 * an LGU that could edit it could strand applications in a status no transition
 * leaves — every application at that status becomes unworkable, with no error
 * message anywhere saying why. That is decision D-5, and read-only is the half
 * that needs no decision at all.
 *
 * ── Roles, not just scopes ──────────────────────────────────────────────
 *
 * Each move names the roles that can make it, resolved from the role table.
 * A client that knows only the scope has to map scopes to roles itself, which
 * is the drift TAB 00 removed — and `rolesGranting` existed for exactly this
 * and had no caller until now.
 */

@Controller('staff/config')
export class WorkflowController {
  @Get('workflow')
  @RequireScopes('applications:read')
  workflow(): Record<string, unknown> {
    return {
      statuses: LIFECYCLE_STATUSES.map((status) => ({
        status,
        // What the applicant is shown for this status. The nineteen internal
        // statuses project onto seven the client displays, and a portal drawing
        // the flow needs to know which internal step an applicant sees as which.
        applicantStatus: applicantStatusOf(status),
        terminal: isTerminal(status),
        awaitingApplicant: requiresApplicantAction(status),
        // Whether an RA 11032 countdown runs here at all. A flow chart that
        // shows a pledge clock on a terminal status is telling an officer the
        // LGU still owes an act.
        pledgeRuns: pledgeApplies(status),
      })),
      transitions: TRANSITIONS.map((rule) => ({
        from: rule.from,
        to: rule.to,
        actors: rule.actors,
        requiresScope: rule.requires,
        roles: rolesGranting(rule.requires, ROLE_SCOPES),
        preconditions: rule.preconditions,
        // Named even when absent, so a client can tell "this move tells the
        // applicant nothing" from "we forgot to ask". Eight moves genuinely
        // carry no notice, which is a recorded gap in the catalogue rather than
        // an omission here.
        notifies: rule.notifies ?? null,
      })),
    };
  }
}
