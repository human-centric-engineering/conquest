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
  loadConditionalTopicsSettings,
  loadTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { validateConditionalTopics } from '@/lib/app/questionnaire/scope/validate';
import { loadScoringSchemaContent } from '@/lib/app/questionnaire/scoring/compute';
import { validateScopeCandidacy } from '@/lib/app/questionnaire/scope/candidacy-schema';
import { loadTopicDraft } from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { resolveAutoTriggerPending } from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';
import { loadRoutingAnalystAgent } from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';

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
  /**
   * Include the "suggested topics are waiting for review" check (default `true`).
   *
   * The launch gate keeps it on; the **preview** gate passes `false`. Rehearsing a draft is how an
   * admin decides what to do about a proposal in the first place, so blocking the rehearsal on
   * having already decided would invert the order the work actually happens in. Nothing a preview
   * session does depends on the draft: it is not live, and the runtime scope resolver never reads
   * it.
   */
  includeConditionalTopicsReview?: boolean;
}

/**
 * How many `error`-severity Conditional Topics findings a version has.
 *
 * Deliberately re-reads the topics and key inventory rather than taking them from the caller: this
 * runs only when the feature is ON, which is a small minority of versions, and paying three extra
 * queries there is cheaper than making every launch check carry topic data it will not use.
 */
async function countConditionalTopicsErrors(
  versionId: string,
  settings: Awaited<ReturnType<typeof loadConditionalTopicsSettings>>
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
  const issues = validateConditionalTopics({
    topics,
    settings,
    allQuestionKeys: questionKeys.map((q) => q.key),
    allDataSlotKeys: dataSlotKeys.map((d) => d.key),
    scoring: scoring ?? undefined,
  });
  return issues.filter((i) => i.severity === 'error').length;
}

/**
 * Has the Routing Analyst still not been run on a document the candidacy check flagged?
 *
 * Only asked when there is no draft to review and the feature is off — i.e. the one state where
 * the answer can change a launch. It costs the two `AppAiRun` reads inside
 * {@link resolveAutoTriggerPending} plus two indexed lookups, and a flagged-but-unreviewed
 * version is a small minority, so paying for it on every launch check would be paying for nothing
 * almost every time.
 *
 * **The seeded-analyst check is what makes this row fail open, and it is load-bearing.**
 * `resolveAutoTriggerPending` counts spent retries from `AppAiRun` rows, and the ONLY writer of a
 * `failed` one is `dispatchRoutingAnalysis`. The analyse route returns ahead of it on three paths,
 * and one of them is permanent: with the Routing Analyst agent unseeded, no run is ever recorded,
 * `failures` stays at 0 forever, and the row could never clear. That would make every flagged draft
 * unlaunchable on a deploy that skipped the seed unit, leaving only "turn Conditional Topics on" or
 * "hand-author a topic" as ways out — the exact coercion this row is designed not to be. The other
 * two early returns cannot strand anything: a rate limit resets in minutes, and a null
 * `buildRoutingAnalysisInput` means the version has no questions, which the `questions` blocker
 * already refuses to launch.
 *
 * `hasDraft` is passed in rather than re-read, and it means **a draft row exists** — NOT "the draft
 * has topics". The two come apart: `narrowProposedTopicSet` drops any topic missing a key or a
 * label, so a row can parse to zero topics, and hard-coding `false` here from a zero-TOPIC draft
 * made this gate disagree with the Topics tab, which computes `hasDraft: draft !== null`
 * (`topics/route.ts`). The disagreement was visible: the launch gate could block with "the
 * suggested topics are not reviewed yet" while the tab reported nothing pending and never fired.
 */
async function detectedButUnreviewed(
  versionId: string,
  candidate: unknown,
  enabled: boolean,
  hasDraft: boolean
): Promise<boolean> {
  const validated = candidate ? validateScopeCandidacy(candidate) : null;
  if (!validated?.ok || !validated.value.isCandidate) return false;

  const [authored, analyst] = await Promise.all([
    prisma.appQuestionnaireTopic.findFirst({
      where: { versionId, source: { not: 'seeded' } },
      select: { id: true },
    }),
    loadRoutingAnalystAgent(),
  ]);
  // Nothing to ask the admin to go and look at: the tab they would be sent to cannot produce a
  // proposal, and its auto-run is silent, so they would find an empty page and no error.
  if (analyst === null) return false;
  return resolveAutoTriggerPending(
    versionId,
    {
      isCandidate: validated.value.isCandidate,
      confidence: validated.value.confidence,
      summary: validated.value.summary,
    },
    { hasAuthoredTopic: authored !== null, hasDraft, enabled }
  );
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
  const includeConditionalTopicsReview = options.includeConditionalTopicsReview ?? true;

  const [
    version,
    sectionCount,
    questionCount,
    scaleSlots,
    config,
    dataSlotCount,
    scopeSettings,
    conditionalTopicCount,
    topicDraft,
  ] = await Promise.all([
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      // `conditionalTopicsCandidate` rides along on a row this function already reads, so the
      // ingestion-time verdict costs nothing here — see {@link detectedButUnreviewed}, which is
      // what actually pays for a query, and only in the state where it can change the answer.
      select: { goal: true, audience: true, conditionalTopicsCandidate: true },
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
    loadConditionalTopicsSettings(versionId),
    // Counted unconditionally, unlike the error count below: it costs one indexed count that
    // rides along in this Promise.all, whereas making it conditional on the settings would cost
    // a serial round-trip after them. It is read only while the feature is OFF.
    prisma.appQuestionnaireTopic.count({ where: { versionId, phase: 'conditional' } }),
    // The pending proposal, unconditionally: it is one lookup on a unique key, and it is the fact
    // the new blocking row is made of. Loading it only when some other condition held would put
    // the row's existence behind a condition the row is supposed to be independent of.
    includeConditionalTopicsReview ? loadTopicDraft(versionId) : Promise.resolve(null),
  ]);

  // Conditional Topics coherence is only a launch concern once the version opted in — while it is off,
  // `validateConditionalTopics` reports the same orphans as WARNINGS on the Topics tab, which is where
  // an admin wants to see them BEFORE flipping the switch, not as a gate on an unrelated launch.
  const conditionalTopicsErrorCount = scopeSettings.enabled
    ? await countConditionalTopicsErrors(versionId, scopeSettings)
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

  // The two halves of "nobody has looked at what this document asked for". A pending proposal is
  // conclusive on its own; the flagged-but-unproposed case is only worth a query when there is no
  // proposal to review and the feature is still off.
  const conditionalTopicsDraftTopicCount = topicDraft?.topics.length ?? 0;
  const conditionalTopicsDetectedUnreviewed =
    includeConditionalTopicsReview &&
    conditionalTopicsDraftTopicCount === 0 &&
    !scopeSettings.enabled
      ? await detectedButUnreviewed(
          versionId,
          version?.conditionalTopicsCandidate ?? null,
          scopeSettings.enabled,
          topicDraft !== null
        )
      : false;

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
    conditionalTopicsEnabled: scopeSettings.enabled,
    conditionalTopicsErrorCount,
    conditionalTopicsConditionalCount: conditionalTopicCount,
    conditionalTopicsDraftTopicCount,
    conditionalTopicsDetectedUnreviewed,
  });

  // `blocksLaunch`, not `every(ok)`: the conditional-topics-with-the-feature-off row is a warning,
  // and a warning must never make a launchable version report itself unready.
  return { ready: !checks.some(blocksLaunch), checks };
}
