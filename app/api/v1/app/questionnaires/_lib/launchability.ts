/**
 * Server launch-readiness seam.
 *
 * Loads a version's readiness facts from the DB and runs them through the pure
 * {@link launchReadinessChecks}. One server source for the launch gate (status route) AND the
 * "Preview as respondent" gate (a launchable draft is previewable before launch) — so the two
 * apply identical criteria. The `lib/app/questionnaire/launch` module stays Prisma-free; this is
 * its DB seam.
 */

import { prisma } from '@/lib/db/client';
import {
  blocksLaunch,
  launchReadinessChecks,
  type LaunchReadinessCheck,
} from '@/lib/app/questionnaire/launch/readiness';
import {
  isLikertLabelled,
  isMatrixLabelled,
} from '@/lib/app/questionnaire/authoring/type-config-schema';
import { slotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { dataSlotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import {
  loadAdaptiveScopeSettings,
  loadTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { validateAdaptiveScope } from '@/lib/app/questionnaire/scope/validate';
import { loadScoringSchemaContent } from '@/lib/app/questionnaire/scoring/compute';

export interface VersionLaunchReadiness {
  ready: boolean;
  checks: LaunchReadinessCheck[];
}

export interface LaunchReadinessOptions {
  /**
   * Include the adaptive "Questions embedded" check (default `true`). The launch gate keeps it on;
   * the **preview** gate passes `false`, so a draft can be rehearsed before its slots are embedded
   * — the live turn loop embeds them lazily as a backstop. See `slot-embeddings.ts`.
   */
  includeEmbeddings?: boolean;
}

/**
 * How many `error`-severity Adaptive Scope findings a version has.
 *
 * Deliberately re-reads the topics and key inventory rather than taking them from the caller: this
 * runs only when the feature is ON, which is a small minority of versions, and paying three extra
 * queries there is cheaper than making every launch check carry topic data it will not use.
 */
async function countAdaptiveScopeErrors(
  versionId: string,
  settings: Awaited<ReturnType<typeof loadAdaptiveScopeSettings>>
): Promise<number> {
  const [topics, questionKeys, dataSlotKeys, scoring] = await Promise.all([
    loadTopics(versionId),
    prisma.appQuestionSlot.findMany({ where: { versionId }, select: { key: true } }),
    prisma.appDataSlot.findMany({ where: { versionId }, select: { key: true } }),
    // The comparability checks (F17.15) run here too, so the Topics tab and this gate cannot
    // disagree. Only one of them is an `error` — a scale scoring a key that EXISTS on the version
    // but belongs to no topic — and it never blocks alone, because that same key already raises
    // `orphaned_questions`. A scale scoring a key the version no longer has is a different finding
    // (`scale_item_stale`) and only a warning: deleting a question does not prune the scoring
    // schema, so blocking launch on it would strand the admin on a tab where the key is not shown.
    loadScoringSchemaContent(versionId),
  ]);
  const issues = validateAdaptiveScope({
    topics,
    settings,
    allQuestionKeys: questionKeys.map((q) => q.key),
    allDataSlotKeys: dataSlotKeys.map((d) => d.key),
    scoring: scoring ?? undefined,
  });
  return issues.filter((i) => i.severity === 'error').length;
}

/**
 * Resolve a version's launch readiness — the same criteria the launch gate enforces (goal,
 * audience, ≥1 section, ≥1 question, a saved config, generated data slots, and — for an `adaptive`
 * version — embedded question slots). `ready` is true when every BLOCKING check passes; the list
 * may also carry warning rows, which are reported and never enforced.
 */
export async function loadLaunchReadiness(
  versionId: string,
  options: LaunchReadinessOptions = {}
): Promise<VersionLaunchReadiness> {
  const includeEmbeddings = options.includeEmbeddings ?? true;

  const [
    version,
    sectionCount,
    questionCount,
    scaleSlots,
    config,
    dataSlotCount,
    scopeSettings,
    conditionalTopicCount,
  ] = await Promise.all([
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      select: { goal: true, audience: true },
    }),
    prisma.appQuestionnaireSection.count({ where: { versionId } }),
    prisma.appQuestionSlot.count({ where: { versionId } }),
    // Likert + matrix configs, to enforce "every rating scale is labelled" before launch (a
    // complete per-point labels array OR both endpoint labels — see isLikertLabelled /
    // isMatrixLabelled; a matrix also needs ≥1 row).
    prisma.appQuestionSlot.findMany({
      where: { versionId, type: { in: ['likert', 'matrix'] } },
      select: { type: true, typeConfig: true },
    }),
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { selectionStrategy: true },
    }),
    prisma.appDataSlot.count({ where: { versionId } }),
    loadAdaptiveScopeSettings(versionId),
    // Counted unconditionally, unlike the error count below: it costs one indexed count that
    // rides along in this Promise.all, whereas making it conditional on the settings would cost
    // a serial round-trip after them. It is read only while the feature is OFF.
    prisma.appQuestionnaireTopic.count({ where: { versionId, phase: 'conditional' } }),
  ]);

  // Adaptive Scope coherence is only a launch concern once the version opted in — while it is off,
  // `validateAdaptiveScope` reports the same orphans as WARNINGS on the Topics tab, which is where
  // an admin wants to see them BEFORE flipping the switch, not as a gate on an unrelated launch.
  const adaptiveScopeErrorCount = scopeSettings.enabled
    ? await countAdaptiveScopeErrors(versionId, scopeSettings)
    : 0;

  // Question embeddings are a launch requirement only for an adaptive version — otherwise adaptive
  // degrades to weighted at runtime and embeddings are irrelevant.
  const embeddingsRequired = includeEmbeddings && config?.selectionStrategy === 'adaptive';
  // Data-slot embeddings are required only when the version actually has data slots (else the
  // deterministic topic-local pick runs and embeddings are moot).
  const dataSlotEmbeddingsRequired = includeEmbeddings && dataSlotCount >= 1;

  const [coverage, dataSlotCoverage] = await Promise.all([
    embeddingsRequired ? slotEmbeddingCoverage(versionId) : Promise.resolve(null),
    dataSlotEmbeddingsRequired ? dataSlotEmbeddingCoverage(versionId) : Promise.resolve(null),
  ]);

  const likertSlots = scaleSlots.filter((s) => s.type === 'likert');
  const matrixSlots = scaleSlots.filter((s) => s.type === 'matrix');
  const unlabelledLikertCount = likertSlots.filter((s) => !isLikertLabelled(s.typeConfig)).length;
  const misconfiguredMatrixCount = matrixSlots.filter(
    (s) => !isMatrixLabelled(s.typeConfig)
  ).length;

  const checks = launchReadinessChecks({
    goal: version?.goal ?? null,
    audience: version?.audience ?? null,
    sectionCount,
    questionCount,
    likertCount: likertSlots.length,
    unlabelledLikertCount,
    matrixCount: matrixSlots.length,
    misconfiguredMatrixCount,
    configSaved: config !== null,
    dataSlotsRequired: true,
    dataSlotsReady: dataSlotCount >= 1,
    embeddingsRequired,
    embeddingsReady: coverage !== null && coverage.total > 0 && coverage.missing === 0,
    dataSlotEmbeddingsRequired,
    dataSlotEmbeddingsReady:
      dataSlotCoverage !== null && dataSlotCoverage.total > 0 && dataSlotCoverage.missing === 0,
    adaptiveScopeEnabled: scopeSettings.enabled,
    adaptiveScopeErrorCount,
    adaptiveScopeConditionalCount: conditionalTopicCount,
  });

  // `blocksLaunch`, not `every(ok)`: the conditional-topics-with-the-feature-off row is a warning,
  // and a warning must never make a launchable version report itself unready.
  return { ready: !checks.some(blocksLaunch), checks };
}
