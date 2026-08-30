import { Body, Controller, Get, HttpStatus, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequireScopes } from '../../identity/transport/guards/public.decorator';
import { ALL_SCOPES, ROLE_SCOPES } from '../../identity/domain/account';
import {
  LIFECYCLE_STATUSES, applicantStatusOf, isTerminal, pledgeApplies,
  requiresApplicantAction, rolesGranting,
} from '../domain/lifecycle';
import { WorkflowConfigService } from '../application/workflow-config.service';
import type { AuthenticatedRequest } from '../../identity/transport/guards/authentication.guard';
import { ProblemException, ProblemType } from '../../../common/problem/problem';

/**
 * The lifecycle, as the server enforces it.
 *
 * ── Editable, rules included. Owner decision D-5, 2026-08-29 ────────────
 *
 * This was read-only until D-5 was answered. The GET still exists for the same
 * reason it always did — the portal draws a flow chart, and serving it means the
 * picture an officer sees is the rule the server actually applies rather than a
 * second statement of it that was true when someone typed it. What changed is
 * that the picture is now also the thing you edit, and the rules on each move —
 * who may make it, what scope it needs, what must hold first — are editable too,
 * not just the arrows.
 *
 * Because the rules are data, the GET now reads the TABLE. The compiled
 * `TRANSITIONS` is the seed a fresh database starts from and is no longer what
 * the server consults; serving it here would have quietly re-introduced exactly
 * the drift this endpoint was built to remove.
 *
 * The stranding hazard that argued for read-only did not go away — it is
 * refused in `WorkflowConfigService` instead, twice: once against the shape of
 * the submitted graph and once against the applications actually sitting in the
 * queue. Weakening a separation-of-duty control is permitted, audited, and named
 * back to the caller in `controlsGivenUp`.
 *
 * ── Roles, not just scopes ──────────────────────────────────────────────
 *
 * Each move names the roles that can make it, resolved from the role table.
 * A client that knows only the scope has to map scopes to roles itself, which
 * is the drift TAB 00 removed — and `rolesGranting` existed for exactly this
 * and had no caller until now.
 */

const transitionShape = z.object({
  from: z.enum(LIFECYCLE_STATUSES),
  to: z.enum(LIFECYCLE_STATUSES),
  actors: z.array(z.enum(['applicant', 'staff'])).min(1).max(2),
  // Closed. A move can require any scope this system has; it cannot require
  // one it does not, because that move could never be made by anybody.
  requiresScope: z.enum(ALL_SCOPES),
  preconditions: z.array(z.string().min(1).max(60)).max(10),
  notifies: z.string().min(1).max(80).nullable(),
  /**
   * DERIVED, and accepted only so the document this endpoint SERVES can be sent
   * straight back to it. The portal reads the workflow, edits one move, and
   * PUTs the result; refusing a field we ourselves emitted would make the
   * obvious client wrong.
   *
   * It is checked rather than ignored. `roles` comes from the role table, so
   * the only way to change who holds a move is to change the scope it needs or
   * the role table itself — an editor that changed this list and got a 200
   * would reasonably believe it had done something.
   */
  roles: z.array(z.string()).optional(),
}).strict().superRefine((move, ctx) => {
  if (move.roles === undefined) return;
  const derived = rolesGranting(move.requiresScope, ROLE_SCOPES);
  if ([...move.roles].sort().join() !== [...derived].sort().join()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['roles'],
      message: 'is derived from requiresScope and cannot be set here. '
        + `${move.requiresScope} is held by ${derived.join(', ') || 'no role'}. `
        + 'Change requiresScope, or change the role in Users & Roles.',
    });
  }
});

const replaceShape = z.object({
  transitions: z.array(transitionShape).min(1).max(200),
}).strict();

@Controller('staff/config')
export class WorkflowController {
  constructor(private readonly config: WorkflowConfigService) {}

  /**
   * Replaces the lifecycle. `staff:administer`, because changing what an
   * officer may do is not one of the things an officer does.
   */
  @Put('workflow')
  @RequireScopes('staff:administer')
  async replace(
    @Req() request: AuthenticatedRequest, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = replaceShape.safeParse(body);
    if (!parsed.success) {
      throw ProblemException.validation(
        parsed.error.issues.map((issue) => ({
          pointer: `/${issue.path.join('/')}`, message: issue.message,
        })),
      );
    }
    const claims = request.caller;
    if (claims === undefined) {
      throw new ProblemException(
        ProblemType.unauthorized, 'Authentication is required', HttpStatus.UNAUTHORIZED,
      );
    }

    const result = await this.config.replace({
      transitions: parsed.data.transitions,
      officer: { accountId: claims.sub, kind: claims.kind, scopes: claims.scopes },
    });
    if (!result.ok) {
      throw new ProblemException(
        ProblemType.unprocessable, 'The lifecycle could not be saved',
        HttpStatus.UNPROCESSABLE_ENTITY, result.detail,
      );
    }

    return {
      transitions: result.transitions,
      // Returned, not buried in a log. An LGU is entitled to configure its own
      // process and equally entitled to be told when it has just removed a
      // control it was relying on.
      controlsGivenUp: result.warnings,
    };
  }

  @Get('workflow')
  @RequireScopes('applications:read')
  async workflow(): Promise<Record<string, unknown>> {
    // The rules IN FORCE, read from the table, not the compiled seed — since
    // D-5 they are two different things and only one of them is what the server
    // actually applies.
    const transitions = await this.config.current();
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
      transitions: transitions.map((rule) => ({
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
