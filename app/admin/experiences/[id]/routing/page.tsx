import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  RoutingRulesPanel,
  type RoutingRuleRow,
} from '@/components/admin/experiences/routing-rules-panel';
import { RoutingPreviewPanel } from '@/components/admin/experiences/routing-preview-panel';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { routableSteps } from '@/lib/app/questionnaire/experiences/views';
import {
  ROUTING_RULE_OPERATORS,
  type RoutingRule,
} from '@/lib/app/questionnaire/experiences/routing/types';
import { danglingRules } from '@/lib/app/questionnaire/experiences/routing/rules';

export const metadata: Metadata = {
  title: 'Experience routing',
};

/**
 * The data-slot keys a rule can test.
 *
 * Drawn from every step's questionnaire, not just the entry one: a journey with three legs can
 * fork after any of them, so a rule may legitimately test something learnt later. Deduped and
 * sorted for the picker.
 */
async function getSlotKeys(versionIds: string[]): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const slots = await prisma.appDataSlot.findMany({
    where: { versionId: { in: versionIds } },
    select: { key: true },
    distinct: ['key'],
    orderBy: { key: 'asc' },
  });
  return slots.map((s) => s.key);
}

/** Resolve each step's effective version — its pin, or the newest launched one. */
async function resolveVersionIds(
  steps: readonly { questionnaireId: string | null; versionId: string | null }[]
): Promise<string[]> {
  const pinned = steps.map((s) => s.versionId).filter((id): id is string => id !== null);
  const unpinnedQuestionnaireIds = steps
    .filter((s) => !s.versionId && s.questionnaireId)
    .map((s) => s.questionnaireId as string);

  if (unpinnedQuestionnaireIds.length === 0) return pinned;

  // One query for every unpinned step, not one per step.
  const newest = await prisma.appQuestionnaireVersion.findMany({
    where: {
      questionnaireId: { in: unpinnedQuestionnaireIds },
      status: 'launched',
      archivedAt: null,
    },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, questionnaireId: true },
  });

  const newestByQuestionnaire = new Map<string, string>();
  for (const version of newest) {
    if (!newestByQuestionnaire.has(version.questionnaireId)) {
      newestByQuestionnaire.set(version.questionnaireId, version.id);
    }
  }

  return [...new Set([...pinned, ...newestByQuestionnaire.values()])];
}

/** Experience workspace — Routing tab. Deterministic rules plus the selector dry-run. */
export default async function ExperienceRoutingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const experience = await getExperienceDetail(id);
  if (!experience) notFound();

  const candidates = routableSteps(experience.steps);

  const [ruleRows, versionIds] = await Promise.all([
    prisma.appExperienceRoutingRule.findMany({
      where: { experienceId: id },
      orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    }),
    resolveVersionIds(experience.steps),
  ]);

  const rules: RoutingRule[] = ruleRows.map((r) => ({
    id: r.id,
    dataSlotKey: r.dataSlotKey,
    operator: narrowToEnum(r.operator, ROUTING_RULE_OPERATORS, 'equals'),
    value: r.value,
    targetStepKey: r.targetStepKey,
    ordinal: r.ordinal,
  }));
  const dangling = new Set(
    danglingRules(
      rules,
      candidates.map((c) => c.key)
    ).map((r) => r.id)
  );

  const rows: RoutingRuleRow[] = rules.map((rule) => ({
    ...rule,
    dangling: dangling.has(rule.id),
  }));

  const slotKeys = await getSlotKeys(versionIds);

  return (
    <div className="max-w-3xl space-y-8">
      <RoutingRulesPanel
        experienceId={id}
        rules={rows}
        candidates={candidates}
        slotKeys={slotKeys}
      />
      <RoutingPreviewPanel experienceId={id} />
    </div>
  );
}
