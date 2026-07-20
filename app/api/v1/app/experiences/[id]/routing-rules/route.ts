/**
 * Experience routing rules (P15.2) — collection endpoint.
 *
 * GET  /api/v1/app/experiences/:id/routing-rules  — rules in evaluation order, with any that
 *      dangle (naming a step key that no longer exists) flagged.
 * POST /api/v1/app/experiences/:id/routing-rules  — append a rule.
 *
 * Both `withAdminAuth`, then 404 on unknown experience.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { narrowToEnum } from '@/lib/app/questionnaire/types';

import { createRoutingRuleSchema } from '@/lib/app/questionnaire/experiences/schemas';
import {
  ROUTING_RULE_OPERATORS,
  type RoutingRule,
} from '@/lib/app/questionnaire/experiences/routing/types';
import { danglingRules } from '@/lib/app/questionnaire/experiences/routing/rules';

/** 404 unless the experience exists. Returns its title for the audit entry. */
async function requireExperience(id: string): Promise<{ id: string; title: string }> {
  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!experience) throw new NotFoundError('Experience not found');
  return experience;
}

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  await requireExperience(id);

  const [rows, steps] = await Promise.all([
    prisma.appExperienceRoutingRule.findMany({
      where: { experienceId: id },
      orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.appExperienceStep.findMany({
      where: { experienceId: id, kind: 'branch' },
      select: { key: true },
    }),
  ]);

  const rules: RoutingRule[] = rows.map((r) => ({
    id: r.id,
    dataSlotKey: r.dataSlotKey,
    operator: narrowToEnum(r.operator, ROUTING_RULE_OPERATORS, 'equals'),
    value: r.value,
    targetStepKey: r.targetStepKey,
    ordinal: r.ordinal,
  }));

  // A rule whose target was deleted is silently skipped at run time, and silence is exactly what
  // lets that mistake survive — so the editor is told which ones they are.
  const dangling = new Set(
    danglingRules(
      rules,
      steps.map((s) => s.key)
    ).map((r) => r.id)
  );

  log.info('Routing rules listed', { experienceId: id, count: rules.length });
  return successResponse(rules.map((rule) => ({ ...rule, dangling: dangling.has(rule.id) })));
});

const handleCreate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;
  const experience = await requireExperience(id);

  const body = await validateRequestBody(request, createRoutingRuleSchema);

  const last = await prisma.appExperienceRoutingRule.findFirst({
    where: { experienceId: id },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });

  const created = await prisma.appExperienceRoutingRule.create({
    data: {
      experienceId: id,
      dataSlotKey: body.dataSlotKey,
      operator: body.operator,
      value: body.value ?? null,
      targetStepKey: body.targetStepKey,
      ordinal: last ? last.ordinal + 1 : 0,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_routing_rule.create',
    entityType: 'app_experience_routing_rule',
    entityId: created.id,
    entityName: `${body.dataSlotKey} ${body.operator} → ${body.targetStepKey}`,
    metadata: { experienceId: id, experienceName: experience.title },
    clientIp,
  });
  log.info('Routing rule created', { experienceId: id, ruleId: created.id });

  return successResponse(created, undefined, { status: 201 });
});

export const GET = handleList;
export const POST = handleCreate;
