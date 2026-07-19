/**
 * Experience routing rules (P15.2) — single-rule endpoint.
 *
 * PATCH  /api/v1/app/experiences/:id/routing-rules/:ruleId — replace the rule (see below).
 * DELETE /api/v1/app/experiences/:id/routing-rules/:ruleId
 *
 * The PATCH takes the WHOLE rule rather than a patch: operator and value are interdependent
 * (switching `exists` to `gt` requires a numeric value to arrive with it), and a partial update
 * would have to re-read the row to re-validate the pair. Sending the whole rule keeps the
 * cross-field check honest at the boundary.
 *
 * Both `withAdminAuth`, then 404 unless the rule exists AND belongs to the named experience.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { updateRoutingRuleSchema } from '@/lib/app/questionnaire/experiences/schemas';

type RuleParams = { id: string; ruleId: string };

/** 404 unless the rule exists and belongs to this experience. */
async function requireOwnedRule(experienceId: string, ruleId: string) {
  const rule = await prisma.appExperienceRoutingRule.findUnique({ where: { id: ruleId } });
  if (!rule || rule.experienceId !== experienceId) {
    throw new NotFoundError('Routing rule not found');
  }
  return rule;
}

const handleUpdate = withAdminAuth<RuleParams>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, ruleId } = await params;

  const before = await requireOwnedRule(id, ruleId);
  const body = await validateRequestBody(request, updateRoutingRuleSchema);

  const updated = await prisma.appExperienceRoutingRule.update({
    where: { id: ruleId },
    data: {
      dataSlotKey: body.dataSlotKey,
      operator: body.operator,
      value: body.value ?? null,
      targetStepKey: body.targetStepKey,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_routing_rule.update',
    entityType: 'app_experience_routing_rule',
    entityId: ruleId,
    changes: computeChanges(before, updated),
    metadata: { experienceId: id },
    clientIp,
  });
  log.info('Routing rule updated', { experienceId: id, ruleId });

  return successResponse(updated);
});

const handleDelete = withAdminAuth<RuleParams>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, ruleId } = await params;

  const rule = await requireOwnedRule(id, ruleId);
  await prisma.appExperienceRoutingRule.delete({ where: { id: ruleId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_routing_rule.delete',
    entityType: 'app_experience_routing_rule',
    entityId: ruleId,
    entityName: `${rule.dataSlotKey} ${rule.operator} → ${rule.targetStepKey}`,
    metadata: { experienceId: id },
    clientIp,
  });
  log.info('Routing rule deleted', { experienceId: id, ruleId });

  return successResponse({ id: ruleId, deleted: true });
});

export const PATCH = handleUpdate;
export const DELETE = handleDelete;
