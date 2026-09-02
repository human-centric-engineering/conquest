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
 * captured, and a judgement over an empty transcript is not a judgement.
 *
 * ## The backstop (F17.36)
 *
 * That gate has no escape, and an instrument can be authored so it never passes: an opening topic
 * naming a question slot that holds a scripted handoff line rather than a question, or a data slot
 * whose description records the interview's own routing decision rather than a respondent fact.
 * Neither can ever be covered by a respondent. Session CPY3-1C6S sat unplanned for exactly this
 * reason, and said nothing about it.
 *
 * `maxOpeningTurns` closes the opening on what there is once the session has taken that many
 * turns. Off by default (`0`), so no existing version changes. When it fires, the plan carries a
 * `forcedClose` record naming the turn, the limit, and the members that were never covered — a
 * forced plan and a considered one are indistinguishable in `topics` alone, and the difference is
 * what an admin holding a thin report needs.
 *
 * ## The time budget
 *
 * A version with `sessionBudgetSeconds` set gets one extra pair of queries — the question types and
 * the data-slot keys — because a plan cannot be fitted to seconds without knowing what each item
 * costs. Every other session pays nothing for it: the load is gated on the setting, which is `0` by
 * default.
 *
 * The pricing itself lives in `questionnaires/_lib/plan-inputs.ts` rather than here, because the
 * authoring dry-run (F17.14) has to reach the SAME arithmetic. A preview that priced the instrument
 * differently from the interview would be a preview that lies, and it would lie quietly.
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
import { planScope, type ScopeAnswer } from '@/lib/app/questionnaire/scope/planner';
import { openingReadiness } from '@/lib/app/questionnaire/scope/readiness';
import {
  narrowConditionalTopicsSettings,
  narrowInterviewPlan,
  type ForcedClose,
  type InterviewPlan,
  type ScopeFill,
} from '@/lib/app/questionnaire/scope/types';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { loadPlanBudget } from '@/app/api/v1/app/questionnaires/_lib/plan-inputs';
import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator/data-slot-orchestrator';

/**
 * How many uncovered member keys a forced close records, per kind.
 *
 * A stall is one or two stuck members in practice. The cap is a bound on the row, not a judgement:
 * an opening topic that names sixty slots and covers none of them has a problem the first ten keys
 * describe just as well as all sixty, and the plan blob is read on the session viewer.
 */
const MAX_UNCOVERED_RECORDED = 10;

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
            config: { select: { conditionalTopics: true } },
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
        // Two jobs. The gate's other half — "answered" is the presence of a row, which is what
        // every other consumer of coverage means by it (`answeredQuestionIds` in
        // selection/context.ts), and a second definition here would let the gate and the progress
        // bar disagree about whether the opening had finished. And the planner's primary evidence:
        // what the respondent actually said, which until now it never saw.
        answers: {
          select: {
            value: true,
            paraphrase: true,
            questionSlot: { select: { key: true, prompt: true } },
          },
        },
        _count: { select: { turns: true } },
      },
    });
    if (!session) return { kind: 'skipped', reason: 'session not found' };

    const settings = narrowConditionalTopicsSettings(session.version.config?.conditionalTopics);
    if (!settings.enabled) return { kind: 'skipped', reason: 'conditional topics is off' };

    // A plan already exists: never re-plan. The interview has been acting on it.
    if (narrowInterviewPlan(session.interviewPlan)) {
      return { kind: 'skipped', reason: 'already planned' };
    }

    const topics = await loadTopics(session.versionId);
    if (topics.length === 0) return { kind: 'skipped', reason: 'no topics authored' };

    // "Covered" mirrors the orchestrator's own definition (`isCovered`): a plainly-stated answer
    // counts however the extractor scored its confidence, so a noisy number cannot hold the
    // opening open forever.
    //
    // Split into given-vs-parked rather than merged into one set, because the two readers of this
    // arithmetic disagree about parks — the gate counts them, the early-seating floor will not —
    // and a pre-merged set cannot be un-merged. Under `countParked: true` the union is exactly the
    // set this used to build, so the gate's behaviour is unchanged.
    const filledKeys = new Set<string>();
    const parkedKeys = new Set<string>();
    for (const f of session.dataSlotFills) {
      const key = f.dataSlot.key;
      if (f.provenanceLabel === 'direct' || (f.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD) {
        filledKeys.add(key);
      } else if (f.provisional) {
        parkedKeys.add(key);
      }
    }
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

    // One measurement, read twice: whether the opening is finished, and — when it is not — exactly
    // what is outstanding, so a forced close can name it. Computing the gate and the outstanding
    // list separately is how the two would come to disagree.
    const readiness = openingReadiness(
      topics,
      // Parks count here, exactly as they always have: the gate must keep honouring the
      // orchestrator's give-up, or it reintroduces the stall parking exists to prevent. The
      // early-seating floor is the reader that excludes them.
      { filled: filledKeys, parked: parkedKeys },
      {
        answered: new Set(session.answers.map((a) => a.questionSlot.key)),
        known: knownQuestionKeys,
      },
      { countParked: true }
    );

    const turnCount = session._count.turns;
    let forcedClose: ForcedClose | undefined;

    if (readiness.ratio < 1) {
      // Off by default, and while off this is the same early return it always was.
      if (settings.maxOpeningTurns <= 0 || turnCount < settings.maxOpeningTurns) {
        return { kind: 'skipped', reason: 'opening still in progress' };
      }
      forcedClose = {
        atTurn: turnCount,
        limitTurns: settings.maxOpeningTurns,
        uncovered: {
          dataSlotKeys: readiness.uncovered.dataSlotKeys.slice(0, MAX_UNCOVERED_RECORDED),
          questionKeys: readiness.uncovered.questionKeys.slice(0, MAX_UNCOVERED_RECORDED),
        },
      };
      // Logged at warn rather than info: reaching here means the instrument has a member no
      // respondent could cover, and that is an authoring fault the operator should see without
      // going looking for it.
      logger.warn('conditional topics: opening force-closed on the turn limit', {
        sessionId,
        turnCount,
        limitTurns: settings.maxOpeningTurns,
        covered: readiness.covered,
        total: readiness.total,
        uncoveredDataSlotKeys: forcedClose.uncovered.dataSlotKeys,
        uncoveredQuestionKeys: forcedClose.uncovered.questionKeys,
      });
    }

    const fills: ScopeFill[] = session.dataSlotFills.map((f) => ({
      key: f.dataSlot.key,
      value: f.value,
      paraphrase: f.paraphrase,
    }));

    // What the respondent actually said. Ordered opening-first because the prompt is capped and the
    // opening is what the plan is a judgement about — a core topic with forty questions must not
    // push the answers the decision rests on out of the prompt.
    const openingKeys = new Set(openingQuestionKeys);
    const answers: ScopeAnswer[] = session.answers
      .map((a) => ({
        key: a.questionSlot.key,
        prompt: a.questionSlot.prompt,
        value: a.value,
        paraphrase: a.paraphrase,
      }))
      .sort((a, b) => Number(openingKeys.has(b.key)) - Number(openingKeys.has(a.key)));

    const budget = await loadPlanBudget(session.versionId, settings, topics);

    // What each candidate topic's questions ASK, so the planner can name a subset of one (C6).
    // One query, and only when a conditional topic actually names questions — an instrument whose
    // conditional topics are data-slot-only pays nothing for it.
    const conditionalQuestionKeys = new Set(
      topics.filter((t) => t.phase === 'conditional').flatMap((t) => t.members.questionKeys)
    );
    const itemPrompts =
      conditionalQuestionKeys.size === 0
        ? undefined
        : new Map(
            (
              await prisma.appQuestionSlot.findMany({
                where: { versionId: session.versionId, key: { in: [...conditionalQuestionKeys] } },
                select: { key: true, prompt: true },
              })
            ).map((q) => [q.key, q.prompt] as const)
          );

    const result = await planScope({
      sessionId,
      topics,
      fills,
      answers,
      goal: session.version.goal,
      settings,
      decidedAtTurn: turnCount,
      ...(budget ? { budget } : {}),
      ...(itemPrompts ? { itemPrompts } : {}),
    });

    // Stamped here rather than inside `planScope` because it is a fact about the SESSION — how
    // this interview reached its decision — not about the decision. The planner reasons over the
    // evidence it was handed and should not have to know whether that evidence was complete.
    const plan: InterviewPlan = forcedClose ? { ...result.plan, forcedClose } : result.plan;

    // Guarded write: `interviewPlan: null` in the WHERE is what makes a concurrent second call a
    // no-op rather than a silent replacement mid-interview.
    const written = await prisma.appQuestionnaireSession.updateMany({
      where: { id: sessionId, interviewPlan: { equals: Prisma.DbNull } },
      data: { interviewPlan: jsonInput(plan) },
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
        // What the fit stage was working to, when there was one. Without these two numbers the
        // audit row records that a topic was dropped but not the arithmetic that dropped it.
        budgetSeconds: result.plan.budgetSeconds ?? null,
        estimatedSeconds: result.plan.estimatedSeconds ?? null,
        // Null on an ordinary plan. Recorded on the audit row as well as the plan so that "why is
        // this report thin" is answerable from the AI run alone, without joining back to a session
        // whose plan may since have been amended.
        forcedClose: forcedClose ?? null,
      },
    });

    logger.info('conditional topics: planned', {
      sessionId,
      source: plan.source,
      confidence: plan.confidence,
      topicKeys: plan.topics.map((t) => t.key),
      forcedClose: forcedClose !== undefined,
      costUsd: result.costUsd,
    });

    return { kind: 'planned', plan, costUsd: result.costUsd };
  } catch (err) {
    // The session simply stays unplanned, which resolves to the always-run topics. A shorter
    // interview is recoverable; a failed turn is not.
    logger.error('conditional topics: planning failed; the interview continues unplanned', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'skipped', reason: 'planning failed' };
  }
}
