/**
 * The early-seating trigger (F17.36) — bringing an area into scope while the opening still runs.
 *
 * The fourth of the post-turn triggers, and the first in the order:
 *
 * ```
 * maybeSeatEarlyTopics  →  maybePlanScope  →  maybeAmendPlan  →  widening rescan
 * ```
 *
 * First because it is the only one that acts BEFORE a plan exists, and it stands down entirely the
 * moment one does. `maybePlanScope` then seals over the top of whatever it seated, absorbing every
 * early seat as a pre-seated key that survives the cap.
 *
 * ## What it costs an ordinary turn
 *
 * One narrowed session read, and then arithmetic. `earlySeatingGate` is tiered cheapest-first, and
 * the condition that removes most turns is not the cadence but the evidence check: a turn that
 * added no new fill and no new answer cannot change the judgement, so it never pays for one. A
 * version that never turned the feature on stops at the first field with no query beyond the read.
 *
 * ## Fail-soft, always
 *
 * Never throws. Every failure leaves the session exactly as it was, which is the same outcome as
 * the feature being off — the interview simply decides at the end, the way it always did. A turn
 * that 500s because an optional improvement failed is not a trade worth making.
 *
 * ## Idempotency
 *
 * The write is guarded on `interviewPlan` still being null. A concurrent `maybePlanScope` that
 * sealed first therefore wins, and this becomes a no-op rather than seating a topic into a plan
 * that has already been made and announced.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { openingReadiness } from '@/lib/app/questionnaire/scope/readiness';
import { judgeEarlySeating } from '@/lib/app/questionnaire/scope/early-planner';
import {
  applyEarlyJudgements,
  drainDeferred,
  earlySeatingCandidates,
  earlySeatingGate,
  evidenceKeyOf,
} from '@/lib/app/questionnaire/scope/early-seating';
import {
  narrowConditionalTopicsSettings,
  narrowEarlySeating,
  narrowInterviewPlan,
  type EarlySeat,
  type ScopeFill,
} from '@/lib/app/questionnaire/scope/types';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator/data-slot-orchestrator';

/** What the trigger did. Never an error. */
export type SeatEarlyTopicsResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'seated'; seated: EarlySeat[]; costUsd: number; fromDeferred: boolean };

/**
 * Seat any area the opening has already made unmistakable. Never throws.
 *
 * Returns `skipped` for every ordinary turn — the feature off, a plan already made, below the
 * coverage floor, or nothing new said since the last pass.
 */
export async function maybeSeatEarlyTopics(sessionId: string): Promise<SeatEarlyTopicsResult> {
  try {
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        versionId: true,
        interviewPlan: true,
        earlySeatedTopics: true,
        version: {
          select: { goal: true, config: { select: { conditionalTopics: true } } },
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
    // The two cheapest possible rejections, before the topic query and before any arithmetic. A
    // version that never turned this on pays exactly the read above and nothing else.
    if (!settings.enabled) return { kind: 'skipped', reason: 'conditional topics is off' };
    if (!settings.earlyTopicSeating) return { kind: 'skipped', reason: 'early seating is off' };

    const plan = narrowInterviewPlan(session.interviewPlan);
    if (plan) return { kind: 'skipped', reason: 'already planned' };

    const early = narrowEarlySeating(session.earlySeatedTopics);
    const turnCount = session._count.turns;

    const topics = await loadTopics(session.versionId);
    if (topics.length === 0) return { kind: 'skipped', reason: 'no topics authored' };

    // Given, parked, and answered — the same three sets `plan-scope.ts` builds, and split the same
    // way. The gate there counts a park as covered; the floor here does not, because a park is a
    // best-effort inference the interviewer gave up on rather than something the respondent said.
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
    const answeredKeys = session.answers.map((a) => a.questionSlot.key);

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

    const questions = { answered: new Set(answeredKeys), known: knownQuestionKeys };
    // Two measurements of the same opening, and the difference is the whole design. The floor reads
    // parks as outstanding; the completion check reads them as covered, exactly as the seal does —
    // so a session whose opening finished on this turn is handed straight to the planner rather
    // than being front-run by one function call.
    const floorReadiness = openingReadiness(
      topics,
      { filled: filledKeys, parked: parkedKeys },
      questions,
      { countParked: false }
    );
    const sealReadiness = openingReadiness(
      topics,
      { filled: filledKeys, parked: parkedKeys },
      questions,
      { countParked: true }
    );

    const fills: ScopeFill[] = session.dataSlotFills.map((f) => ({
      key: f.dataSlot.key,
      value: f.value,
      paraphrase: f.paraphrase,
    }));
    const evidenceKey = evidenceKeyOf(fills, answeredKeys);

    const gate = earlySeatingGate({
      settings,
      early,
      plan,
      readiness: floorReadiness,
      turnCount,
      evidenceKey,
      openingComplete: sealReadiness.ratio === 1,
    });
    if (gate.kind === 'stop') return { kind: 'skipped', reason: gate.reason };

    // Tier 0: what a previous pass judged and the per-turn cap could not take. No model call, and
    // no new judgement — so the cadence and evidence bookkeeping is deliberately left alone.
    if (gate.kind === 'drain') {
      const applied = drainDeferred(early, gate.picks, turnCount);
      const written = await write(sessionId, applied.early);
      if (!written) return { kind: 'skipped', reason: 'the plan was sealed first' };
      logger.info('early seating: seated from deferred picks', {
        sessionId,
        turnCount,
        topicKeys: applied.newlySeated.map((s) => s.key),
      });
      return { kind: 'seated', seated: applied.newlySeated, costUsd: 0, fromDeferred: true };
    }

    // Tier 2: the narrowed read. Everything already seated is out, because re-judging a topic the
    // interview is already covering is spend for a decision that has been taken.
    const candidates = earlySeatingCandidates(topics, early);
    if (candidates.length === 0) return { kind: 'skipped', reason: 'no eligible candidates' };

    // Tier 3: the one call.
    const judged = await judgeEarlySeating({
      sessionId,
      candidates,
      fills,
      answers: session.answers.map((a) => ({
        key: a.questionSlot.key,
        prompt: a.questionSlot.prompt,
        value: a.value,
        paraphrase: a.paraphrase,
      })),
      goal: session.version.goal,
      settings,
      coveragePct: Math.round(floorReadiness.ratio * 100),
      maxThisTurn: gate.remainingTurnSeats,
    });

    const applied = applyEarlyJudgements({
      early,
      judgements: judged.judgements,
      topics,
      settings,
      remainingSessionSeats: gate.remainingSessionSeats,
      remainingTurnSeats: gate.remainingTurnSeats,
      turnCount,
      evidenceKey,
    });

    // The record is written even when nothing was seated, and that is the point: it stamps the
    // evidence key and the pass turn, which is what stops the next turn paying for the same
    // question over the same evidence. A pass that judged nothing is still a pass.
    const written = await write(sessionId, applied.early);
    if (!written) return { kind: 'skipped', reason: 'the plan was sealed first' };

    // Only when a model was actually asked. A drained pick and a cadence skip are not judgements,
    // and recording them would pollute the audit trail with rows nobody decided anything in.
    if (judged.promptSnapshot) {
      void recordAiRun({
        subjectKind: 'session',
        subjectId: sessionId,
        kind: 'scope_plan',
        status: 'succeeded',
        provider: judged.provider ?? 'deterministic',
        model: judged.model ?? 'deterministic',
        promptSnapshot: judged.promptSnapshot,
        outputSnapshot: judged.outputSnapshot,
        costUsd: judged.costUsd,
        detail: {
          stage: 'early_seating',
          atTurn: turnCount,
          openingCoverage: floorReadiness.ratio,
          seated: applied.newlySeated.map((s) => ({ key: s.key, confidence: s.confidence })),
          // What the caps could not take. Recorded because a cap that quietly discards decisions
          // reads afterwards as "the planner only found one area" when it found four.
          deferred: applied.early.deferred.map((s) => s.key),
          overCap: applied.early.overCap,
          candidateKeys: candidates.map((t) => t.key),
        },
      });
    }

    if (applied.newlySeated.length === 0) {
      return { kind: 'skipped', reason: 'nothing was clear enough to seat' };
    }

    logger.info('early seating: seated during the opening', {
      sessionId,
      turnCount,
      openingCoverage: floorReadiness.ratio,
      topicKeys: applied.newlySeated.map((s) => s.key),
      deferredCount: applied.early.deferred.length,
      costUsd: judged.costUsd,
    });

    return {
      kind: 'seated',
      seated: applied.newlySeated,
      costUsd: judged.costUsd,
      fromDeferred: false,
    };
  } catch (err) {
    // The session simply keeps deciding at the end of the opening, the way it always did.
    logger.error('early seating failed; the interview decides at the end as usual', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'skipped', reason: 'early seating failed' };
  }
}

/**
 * Write the record, but only while the session is still unplanned.
 *
 * The `interviewPlan: null` guard is what makes a concurrent seal win: a topic seated into a plan
 * that has already been made and announced would widen an interview whose respondent has just been
 * told what it covers.
 */
async function write(sessionId: string, early: unknown): Promise<boolean> {
  const result = await prisma.appQuestionnaireSession.updateMany({
    where: { id: sessionId, interviewPlan: { equals: Prisma.DbNull } },
    data: { earlySeatedTopics: jsonInput(early) },
  });
  return result.count > 0;
}
