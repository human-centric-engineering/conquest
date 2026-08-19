/**
 * Route-local scope-structure loader for the Adaptive Scope evaluation panel (F17.21).
 *
 * Maps a questionnaire version's persisted Adaptive Scope config (topics, hard rules, settings)
 * plus its question/data-slot inventory into the pure {@link ScopeStructureInput} DTO the judges
 * read. This is the DB seam — `lib/app/questionnaire/scope-evaluation/**` stays Prisma-free, the
 * same split as `evaluation-structure.ts` for the design-evaluation panel.
 *
 * Reuses the SAME pricing (`scope/budget.ts`) and coherence-checker (`validateAdaptiveScope`)
 * calls the Topics tab's own GET route makes, rather than re-deriving them — "one implementation,
 * so the number an author reads on the Topics tab and the number a judge is handed cannot
 * disagree" applies to the judges exactly as it does to the tab itself.
 */

import { prisma } from '@/lib/db/client';
import {
  alwaysTopicSeconds,
  estimateTopicCosts,
  itemSeconds,
  matrixRowCount,
  routedAllowanceSeconds,
} from '@/lib/app/questionnaire/scope/budget';
import { describeScopeRule } from '@/lib/app/questionnaire/scope/rule-format';
import { validateAdaptiveScope } from '@/lib/app/questionnaire/scope/validate';
import { loadScoringSchemaContent } from '@/lib/app/questionnaire/scoring/compute';
import type { ScopeStructureInput } from '@/lib/app/questionnaire/scope-evaluation';
import {
  loadAdaptiveScopeSettings,
  loadMaxDataSlotAttempts,
  loadTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/**
 * Load the scope-structure DTO for one version, scoped to its parent questionnaire (a mismatched
 * id/versionId pair returns `null` → 404 at the route).
 */
export async function buildScopeEvaluationStructure(
  questionnaireId: string,
  versionId: string
): Promise<ScopeStructureInput | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: { id: true },
  });
  if (!version) return null;

  // Settings first: the key inventory and cost pricing both read the version's per-type overrides.
  const settings = await loadAdaptiveScopeSettings(versionId);

  const [topics, questions, dataSlots, scoring, maxDataSlotAttempts] = await Promise.all([
    loadTopics(versionId),
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      select: { key: true, prompt: true, type: true, typeConfig: true, weight: true },
    }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      select: { key: true, name: true, weight: true },
    }),
    // For the comparability checks inside `validateAdaptiveScope` — null for versions that don't score.
    loadScoringSchemaContent(versionId),
    // For the opening follow-up checks (G03) inside `validateAdaptiveScope`.
    loadMaxDataSlotAttempts(versionId),
  ]);

  const seconds = itemSeconds(
    questions.map((q) => ({ key: q.key, type: q.type, rowCount: matrixRowCount(q.typeConfig) })),
    dataSlots.map((d) => d.key),
    settings
  );
  const weights = {
    byQuestionKey: new Map(questions.map((q) => [q.key, q.weight] as const)),
    byDataSlotKey: new Map(dataSlots.map((d) => [d.key, d.weight] as const)),
  };

  const byTopicKey = estimateTopicCosts(topics, seconds, weights);
  const alwaysSeconds = alwaysTopicSeconds(topics, byTopicKey);
  const conditionalCosts = topics
    .filter((t) => t.phase === 'conditional')
    .map((t) => byTopicKey.get(t.key)?.full ?? 0)
    .filter((s) => s > 0);

  const knownIssues = validateAdaptiveScope({
    topics,
    settings,
    allQuestionKeys: questions.map((q) => q.key),
    allDataSlotKeys: dataSlots.map((d) => d.key),
    seconds: {
      always: alwaysSeconds,
      cheapestConditional: conditionalCosts.length > 0 ? Math.min(...conditionalCosts) : 0,
      byTopicKey: Object.fromEntries([...byTopicKey].map(([key, cost]) => [key, cost.full])),
    },
    scoring: scoring ?? undefined,
    maxDataSlotAttempts,
  }).map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.topicKey ? { topicKey: issue.topicKey } : {}),
  }));

  const questionPromptByKey = new Map(questions.map((q) => [q.key, q.prompt] as const));
  const dataSlotNameByKey = new Map(dataSlots.map((d) => [d.key, d.name] as const));
  const topicLabelByKey = new Map(topics.map((t) => [t.key, t.label] as const));

  return {
    topics: topics.map((topic) => ({
      key: topic.key,
      label: topic.label,
      phase: topic.phase,
      criteria: topic.criteria,
      depth: topic.depth,
      members: [
        ...topic.members.questionKeys.map((key) => ({
          key,
          label: questionPromptByKey.get(key) ?? key,
        })),
        ...topic.members.dataSlotKeys.map((key) => ({
          key,
          label: dataSlotNameByKey.get(key) ?? key,
        })),
      ],
    })),
    rules: settings.rules.map((rule) => ({
      id: rule.id,
      sentence: describeScopeRule(rule, topicLabelByKey, dataSlotNameByKey),
      dataSlotKey: rule.dataSlotKey,
      topicKey: rule.topicKey,
      operator: rule.operator,
      action: rule.action,
    })),
    settings: {
      maxConditionalTopics: settings.maxConditionalTopics,
      includeCheckTopic: settings.includeCheckTopic,
      fallbackTopicKeys: settings.fallbackTopicKeys,
      minConfidence: settings.minConfidence,
      plannerInstructions: settings.plannerInstructions,
      sessionBudgetSeconds: settings.sessionBudgetSeconds,
      limitOpeningProbes: settings.limitOpeningProbes,
      maxOpeningProbes: settings.maxOpeningProbes,
    },
    costs: {
      budgetSeconds: settings.sessionBudgetSeconds,
      alwaysSeconds,
      routedAllowanceSeconds: routedAllowanceSeconds(settings.sessionBudgetSeconds, alwaysSeconds),
      perTopic: [...byTopicKey].map(([key, cost]) => ({
        key,
        fullSeconds: cost.full,
        lightSeconds: cost.light,
      })),
    },
    knownIssues,
  };
}
