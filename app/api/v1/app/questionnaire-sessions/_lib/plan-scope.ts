/**
 * The Scope Planner trigger (P17) — deciding a session's interview plan, once.
 *
 * Called after a turn is persisted. By then the turn's data-slot fills are on the row, so the
 * planner reads the opening as the respondent actually left it rather than as it stood mid-turn.
 *
 * ## Why AFTER the turn rather than during it
 *
 * The plan has to exist before the NEXT turn's `buildTurnContext` runs, because that is when the
 * conditional topics come into scope. Running it here achieves that without touching the streaming
 * generator, and it puts the announcement in exactly the right place: immediately before the first
 * deeper question, rather than trailing the opening answer it was derived from.
 *
 * ## The opening gate
 *
 * Planning waits until every member of every opening topic is covered — its data slots filled AND
 * its questions answered. Both halves matter: an opening topic built only from questions used to
 * read as complete before it had been asked, which put the decision on turn one with nothing
 * captured. The cost is not only a less-informed judgement. Hard rules are evaluated at that same
 * moment, and `not_exists` matches on ABSENCE, so an early gate fires every veto an author wrote
 * for every respondent — and the resulting plan looks entirely reasonable.
 *
 * ## Fail-soft, always
 *
 * Every failure leaves the session with no plan, which resolves to the always-run topics. A
 * respondent whose planner failed gets a shorter interview; a respondent whose turn 500s because
 * planning failed gets nothing. The trade is not close.
 *
 * ## Idempotency
 *
 * The write is conditional on `interviewPlan` still being null (`updateMany` with a null guard), so
 * a double-tapped turn or a retry cannot replace a plan the interview has already started acting
 * on. A plan that moved under a running interview would silently change what was asked.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { isOpeningComplete, planScope } from '@/lib/app/questionnaire/scope/planner';
import type { ScopeFill } from '@/lib/app/questionnaire/scope/rules';
import {
  narrowAdaptiveScopeSettings,
  narrowInterviewPlan,
  type InterviewPlan,
} from '@/lib/app/questionnaire/scope/types';
import { toTopic, TOPIC_SELECT } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator/data-slot-orchestrator';

/** What the trigger decided, for the caller's logging. Never an error. */
export type PlanScopeTriggerResult =
  { kind: 'skipped'; reason: string } | { kind: 'planned'; plan: InterviewPlan; costUsd: number };

/**
 * Plan a session's scope if it is due. Never throws.
 *
 * Returns `skipped` for every ordinary session — the feature off, no topics, a plan already made,
 * or an opening still in progress — which is the overwhelmingly common case and costs one small
 * query.
 */
export async function maybePlanScope(sessionId: string): Promise<PlanScopeTriggerResult> {
  try {
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        versionId: true,
        interviewPlan: true,
        version: {
          select: {
            goal: true,
            config: { select: { adaptiveScope: true } },
          },
        },
        dataSlotFills: {
          select: {
            confidence: true,
            value: true,
            paraphrase: true,
            provisional: true,
            provenanceLabel: true,
            dataSlot: { select: { key: true } },
          },
        },
        // The opening gate's other half. "Answered" is the presence of a row, which is what every
        // other consumer of coverage means by it (`answeredQuestionIds` in selection/context.ts) —
        // a second definition here would let the gate and the progress bar disagree about whether
        // the opening had finished.
        answers: { select: { questionSlot: { select: { key: true } } } },
        _count: { select: { turns: true } },
      },
    });
    if (!session) return { kind: 'skipped', reason: 'session not found' };

    const settings = narrowAdaptiveScopeSettings(session.version.config?.adaptiveScope);
    if (!settings.enabled) return { kind: 'skipped', reason: 'adaptive scope is off' };

    // A plan already exists: never re-plan. The interview has been acting on it.
    if (narrowInterviewPlan(session.interviewPlan)) {
      return { kind: 'skipped', reason: 'already planned' };
    }

    const rows = await prisma.appQuestionnaireTopic.findMany({
      where: { versionId: session.versionId },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });
    const topics = rows.map(toTopic);
    if (topics.length === 0) return { kind: 'skipped', reason: 'no topics authored' };

    // "Covered" mirrors the orchestrator's own definition (`isCovered`): a plainly-stated answer
    // counts however the extractor scored its confidence, so a noisy number cannot hold the
    // opening open forever.
    const filledKeys = new Set(
      session.dataSlotFills
        .filter(
          (f) =>
            f.provenanceLabel === 'direct' ||
            (f.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD ||
            f.provisional
        )
        .map((f) => f.dataSlot.key)
    );
    // The version's question keys, needed only to tell a genuinely-unanswered opening question from
    // a member key that no longer resolves. Fetched only when an opening topic actually names
    // questions, so the ordinary session pays nothing for it.
    const openingQuestionKeys = topics
      .filter((t) => t.phase === 'opening')
      .flatMap((t) => t.members.questionKeys);
    const knownQuestionKeys =
      openingQuestionKeys.length === 0
        ? new Set<string>()
        : new Set(
            (
              await prisma.appQuestionSlot.findMany({
                where: { versionId: session.versionId },
                select: { key: true },
              })
            ).map((q) => q.key)
          );

    if (
      !isOpeningComplete(topics, filledKeys, {
        answered: new Set(session.answers.map((a) => a.questionSlot.key)),
        known: knownQuestionKeys,
      })
    ) {
      return { kind: 'skipped', reason: 'opening still in progress' };
    }

    const fills: ScopeFill[] = session.dataSlotFills.map((f) => ({
      key: f.dataSlot.key,
      value: f.value,
      paraphrase: f.paraphrase,
    }));

    const result = await planScope({
      sessionId,
      topics,
      fills,
      goal: session.version.goal,
      settings,
      decidedAtTurn: session._count.turns,
    });

    // Guarded write: `interviewPlan: null` in the WHERE is what makes a concurrent second call a
    // no-op rather than a silent replacement mid-interview.
    const written = await prisma.appQuestionnaireSession.updateMany({
      where: { id: sessionId, interviewPlan: { equals: Prisma.DbNull } },
      data: { interviewPlan: jsonInput(result.plan) },
    });
    if (written.count === 0) {
      return { kind: 'skipped', reason: 'another call planned this session first' };
    }

    // Every plan is recorded — including the ones no model produced. "Why did this respondent get
    // those topics" is a question an admin will ask months later, and a deterministic answer is as
    // worth defending as an inferred one. `deterministic` is a real, filterable value rather than a
    // fake provider slug, so cost trends are not polluted by these rows.
    void recordAiRun({
      subjectKind: 'session',
      subjectId: sessionId,
      kind: 'scope_plan',
      status: 'succeeded',
      provider: result.provider ?? 'deterministic',
      model: result.model ?? 'deterministic',
      promptSnapshot: result.promptSnapshot,
      outputSnapshot: result.outputSnapshot,
      costUsd: result.costUsd,
      detail: {
        source: result.plan.source,
        confidence: result.plan.confidence,
        selected: result.plan.topics.map((t) => ({
          key: t.key,
          depth: t.depth,
          source: t.source,
          rationale: t.rationale,
        })),
        excluded: result.plan.excluded.map((t) => t.key),
        checkTopicKey: result.plan.checkTopicKey,
        candidateKeys: topics.filter((t) => t.phase === 'conditional').map((t) => t.key),
      },
    });

    logger.info('adaptive scope: planned', {
      sessionId,
      source: result.plan.source,
      confidence: result.plan.confidence,
      topicKeys: result.plan.topics.map((t) => t.key),
      costUsd: result.costUsd,
    });

    return { kind: 'planned', plan: result.plan, costUsd: result.costUsd };
  } catch (err) {
    // The session simply stays unplanned, which resolves to the always-run topics. A shorter
    // interview is recoverable; a failed turn is not.
    logger.error('adaptive scope: planning failed; the interview continues unplanned', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'skipped', reason: 'planning failed' };
  }
}
