import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { ProblemException } from '../http/problem';
import { AuthenticatedRequest, RequireScopes } from '../identity/auth.guard';
import { mayConfirm } from '../identity/authorisation';
import { ConfirmationService } from './confirmation.service';

const proposalSchema = z.object({
  entityType: z.string().min(1).max(40),
  entityId: z.string().min(1).max(80),
  fieldName: z.string().min(1).max(80),
  proposedValue: z.string().min(1).max(4000),
  sourceDescription: z.string().min(8).max(2000),
  sourcedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['direct-read', 'search-extraction', 'official-document']),
}).strict();

const revertSchema = z.object({
  entityType: z.string().min(1).max(40),
  entityId: z.string().min(1).max(80),
  fieldName: z.string().min(1).max(80),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProblemException.badRequest(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

/**
 * The staff surface for TAB 02's confirmation workflow.
 *
 * The actor is ALWAYS the signed-in principal's email and never a field in the
 * body. A body-supplied author is a four-eyes rule anyone can defeat by typing
 * a colleague's address.
 */
@Controller('staff/workflow')
export class WorkflowController {
  constructor(private readonly workflow: ConfirmationService) {}

  @Get('backlog')
  @RequireScopes('content:read')
  async backlog(): Promise<unknown> {
    return { backlog: await this.workflow.backlog() };
  }

  @Post('proposals')
  @RequireScopes('content:propose')
  @HttpCode(201)
  async propose(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const input = parse(proposalSchema, body);
    const result = await this.workflow.propose({
      ...input, proposedBy: request.principal!.email,
    });
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { proposalId: result.value };
  }

  @Post('proposals/:id/confirm')
  @RequireScopes('content:confirm')
  @HttpCode(200)
  async confirm(
    @Param('id') id: string, @Req() request: AuthenticatedRequest,
  ): Promise<{ confirmed: true }> {
    const principal = request.principal!;
    const author = await this.workflow.authorOf(id);
    if (author === null) throw ProblemException.notFound('Proposal', id);

    // Checked HERE, before the domain, so the rule is enforced by
    // authorisation and not only by the workflow it protects.
    const decision = mayConfirm(principal, author);
    if (!decision.permitted) throw ProblemException.forbidden(decision.reason);

    const result = await this.workflow.confirm(id, principal.email);
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { confirmed: true };
  }

  @Post('revert')
  @RequireScopes('content:confirm')
  @HttpCode(200)
  async revert(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const input = parse(revertSchema, body);
    const result = await this.workflow.revert(
      input.entityType, input.entityId, input.fieldName, request.principal!.email);
    if (!result.ok) throw ProblemException.conflict(result.reason);
    return { reverted: true };
  }
}
