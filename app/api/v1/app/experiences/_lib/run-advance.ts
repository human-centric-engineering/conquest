/**
 * `advanceExperienceRun` — the handoff. The heart of the switcher.
 *
 * Called (fail-soft, via `after()`) when a leg's session is submitted. Resolves the fork and either
 * mints the next leg or concludes the run.
 *
 * ## Order of resolution
 *
 * 1. **Budget gate.** A run at hard cap concludes regardless of what any rule or the selector
 *    wants — continuing is precisely what the budget exists to prevent.
 * 2. **Deterministic rules.** First match wins; the LLM is never called.
 * 3. **The LLM selector**, then the configured fallback on any failure.
 *
 * Carry-over is built BEFORE the decision, because the rules evaluate against its fills. The
 * summarisation pass runs AFTER, once the destination is known, so the bridging line can actually
 * reference where the respondent is going.
 *
 * ## Idempotency
 *
 * `after()`, a double-tapped submit and a cron retry can all race this function. Rather than a
 * read-then-write check (which loses the race), `@@unique([runId, ordinal])` on the leg table
 * arbitrates: a P2002 means another caller already created this leg, which is success, and the
 * loser returns `noop` without side effects. **Never replace that with a pre-flight existence
 * check.**
 *
 * ## Never strand a respondent
 *
 * Every dead end resolves to `conclude`, not to an error: an exhausted budget, no candidates, a
 * chosen step whose version was deleted, a closed round window. Someone who has just finished a
 * questionnaire must always end up with a report — a run left mid-flight means they sit on a
 * spinner until it times out and receive nothing. `blocked` is reserved for an incoherent CALL
 * (unknown run, a session that is not one of its legs), not for a journey that cannot continue.
 *
 * Never throws — a failure returns a `blocked` result and is logged. A respondent's submit
 * confirmation must never depend on this succeeding.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  EXPERIENCE_ROUTING_FALLBACKS,
  type RoutingDecision,
} from '@/lib/app/questionnaire/experiences/types';
import type { AdvanceResult, ConcludeReason } from '@/lib/app/questionnaire/experiences/run/types';
import {
  isTerminalRunStatus,
  EXPERIENCE_RUN_STATUSES,
} from '@/lib/app/questionnaire/experiences/run/types';
import { mustConcludeForBudget } from '@/lib/app/questionnaire/experiences/run/cost';
import { buildCarryOver } from '@/lib/app/questionnaire/experiences/carryover/build';
import { evaluateRoutingRules } from '@/lib/app/questionnaire/experiences/routing/rules';
import { selectNextStep } from '@/lib/app/questionnaire/experiences/routing/select';
import {
  budgetConcludeDecision,
  concludeDecision,
  routeDecision,
} from '@/lib/app/questionnaire/experiences/routing/fallback';
import {
  ROUTING_RULE_OPERATORS,
  type RoutingRule,
} from '@/lib/app/questionnaire/experiences/routing/types';
import type { CandidateStep } from '@/lib/app/questionnaire/experiences/routing/types';
import { serialiseCarryOver } from '@/lib/app/questionnaire/experiences/carryover/narrow';
import { createSessionForExperienceLeg } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
// Shared with the step-report scope: a report must analyse the same version the legs ran.
import { resolveStepVersionId } from '@/app/api/v1/app/experiences/_lib/steps';
import { enqueueRunReport } from '@/lib/app/questionnaire/report/enqueue';

/**
 * Mark a run concluded. Idempotent — a second call is a no-op update.
 *
 * This is the single choke point where a journey is known to be over, and therefore the one place
 * the run-level report is enqueued (F15.4b). Every dead end funnels through here — the selector
 * choosing to conclude, an exhausted budget, no candidates, an unrunnable step — so a respondent
 * always ends up with a report regardless of WHY their journey ended.
 */
async function concludeRun(
  runId: string,
  decision: RoutingDecision,
  reason: ConcludeReason
): Promise<AdvanceResult> {
  await prisma.appExperienceRun.update({
    where: { id: runId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      routingDecision: { ...decision, concludeReason: reason },
    },
  });

  // Fail-soft, exactly like the per-session enqueue at submit: the run IS concluded, and failing
  // to queue a report must not turn that into a failed advance and leave the run mid-flight.
  // The respondent's client polls for `conclude` either way; a missing report shows as "not ready"
  // rather than stranding them.
  await enqueueRunReport(runId).catch((err: unknown) => {
    logger.error('experience conclude: run report enqueue failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { kind: 'conclude', runId, reason };
}

/**
 * Advance a run past the leg that just completed.
 *
 * @param runId the run to advance
 * @param completedSessionId the session that was just submitted — supplied so a stale call for an
 *   earlier leg can be recognised and ignored rather than double-advancing the run
 */
export async function advanceExperienceRun(
  runId: string,
  completedSessionId: string
): Promise<AdvanceResult> {
  try {
    const run = await prisma.appExperienceRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        spentUsd: true,
        respondentUserId: true,
        cohortMemberId: true,
        experience: {
          select: {
            id: true,
            costBudgetUsd: true,
            routingFallback: true,
            minRoutingConfidence: true,
            routingInstructions: true,
            settings: true,
            steps: {
              orderBy: { ordinal: 'asc' },
              select: {
                id: true,
                key: true,
                kind: true,
                title: true,
                purpose: true,
                selectionCriteria: true,
                ordinal: true,
                questionnaireId: true,
                versionId: true,
                roundId: true,
              },
            },
            routingRules: { orderBy: { ordinal: 'asc' } },
          },
        },
        legs: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, sessionId: true, ordinal: true, stepId: true },
        },
      },
    });

    if (!run) {
      return { kind: 'blocked', runId, code: 'RUN_NOT_FOUND', message: 'Run not found' };
    }
    const status = narrowToEnum(run.status, EXPERIENCE_RUN_STATUSES, 'active');
    if (isTerminalRunStatus(status)) {
      // Already finished — a retry or a late `after()` firing. Not an error.
      return { kind: 'noop', runId };
    }

    const currentLeg = run.legs.find((l) => l.sessionId === completedSessionId);
    if (!currentLeg) {
      return {
        kind: 'blocked',
        runId,
        code: 'LEG_NOT_COMPLETE',
        message: 'That session is not a leg of this run',
      };
    }
    // A leg beyond this one already exists, so the fork was resolved by an earlier call.
    if (run.legs.some((l) => l.ordinal > currentLeg.ordinal)) {
      return { kind: 'noop', runId };
    }

    const experience = run.experience;
    const settings = narrowExperienceSettings(experience.settings);
    const stepByKey = new Map(experience.steps.map((s) => [s.key, s]));
    const sourceStep = experience.steps.find((s) => s.id === currentLeg.stepId);

    // Candidates: branch steps with a questionnaire attached. A branch with none is half-authored
    // and must never be offered — routing into nothing is worse than concluding.
    const candidates: CandidateStep[] = experience.steps
      .filter((s) => s.kind === 'branch' && s.questionnaireId !== null)
      .map((s) => ({
        stepKey: s.key,
        title: s.title,
        purpose: s.purpose,
        selectionCriteria: s.selectionCriteria,
        ordinal: s.ordinal,
      }));

    // Mark the leg complete and the run awaiting its fork before any slow work, so a concurrent
    // poll sees an honest state rather than "active" while the selector runs.
    await prisma.$transaction([
      prisma.appExperienceRunLeg.update({
        where: { id: currentLeg.id },
        data: { status: 'completed', completedAt: new Date() },
      }),
      prisma.appExperienceRun.update({
        where: { id: runId },
        data: { status: 'awaiting_handoff' },
      }),
    ]);

    // --- Carry-over (deterministic layer only for now; the summary needs the destination) -------
    const deterministic = await buildCarryOver({
      sessionId: completedSessionId,
      fromStepKey: sourceStep?.key ?? '',
      carryProfile: settings.carryProfile,
      summarise: false,
      next: null,
    });

    // --- 1. Budget gate ------------------------------------------------------------------------
    let decision: RoutingDecision;
    let selectorCost = 0;
    let selectorProvider: string | null = null;
    let selectorModel: string | null = null;
    let promptSnapshot: string | null = null;
    let outputSnapshot: unknown = null;

    if (mustConcludeForBudget(run.spentUsd, experience.costBudgetUsd)) {
      decision = budgetConcludeDecision(run.spentUsd, experience.costBudgetUsd ?? 0);
    } else {
      // --- 2. Deterministic rules --------------------------------------------------------------
      const rules: RoutingRule[] = experience.routingRules.map((r) => ({
        id: r.id,
        dataSlotKey: r.dataSlotKey,
        operator: narrowToEnum(r.operator, ROUTING_RULE_OPERATORS, 'equals'),
        value: r.value,
        targetStepKey: r.targetStepKey,
        ordinal: r.ordinal,
      }));
      const ruleTarget = evaluateRoutingRules(
        rules,
        deterministic.context.fills,
        candidates.map((c) => c.stepKey)
      );

      if (ruleTarget) {
        decision = routeDecision(
          ruleTarget,
          `Matched a routing rule targeting "${ruleTarget}".`,
          'rule'
        );
      } else {
        // --- 3. The LLM selector, with its own fallback ----------------------------------------
        const selected = await selectNextStep({
          experienceId: experience.id,
          candidates,
          carryOver: deterministic.context,
          routingInstructions: experience.routingInstructions,
          fallback: narrowToEnum(
            experience.routingFallback,
            EXPERIENCE_ROUTING_FALLBACKS,
            'conclude'
          ),
          minConfidence: experience.minRoutingConfidence,
          defaultStepKey: candidates[0]?.stepKey ?? null,
        });
        decision = selected.decision;
        selectorCost = selected.costUsd;
        selectorProvider = selected.provider;
        selectorModel = selected.model;
        promptSnapshot = selected.promptSnapshot;
        outputSnapshot = selected.outputSnapshot;
      }
    }

    // Every decision is recorded — including rule and budget outcomes. "Why did this respondent get
    // that questionnaire" is a question an admin will ask months later, and a deterministic answer
    // is as worth defending as an LLM one.
    void recordAiRun({
      subjectKind: 'experience_run',
      subjectId: runId,
      kind: 'experience_routing',
      status: 'succeeded',
      // A rule or budget decision involves no LLM call, but is still recorded — the audit question
      // is "why did this respondent get that questionnaire", and a deterministic answer is as worth
      // defending as an inferred one. `deterministic` is a real, filterable value rather than a
      // fake provider slug, so provider/model cost trends are not polluted by these rows.
      provider: selectorProvider ?? 'deterministic',
      model: selectorModel ?? 'deterministic',
      promptSnapshot,
      outputSnapshot,
      costUsd: selectorCost,
      detail: {
        source: decision.source,
        decision: decision.decision,
        selectedStepKey: decision.selectedStepKey,
        confidence: decision.confidence,
        rationale: decision.rationale,
        candidateKeys: candidates.map((c) => c.stepKey),
      },
    });

    // --- Conclude ------------------------------------------------------------------------------
    if (decision.decision === 'conclude' || !decision.selectedStepKey) {
      const reason: ConcludeReason =
        decision.source === 'budget'
          ? 'budget'
          : candidates.length === 0
            ? 'no_candidates'
            : decision.source === 'fallback'
              ? 'fallback'
              : 'selector';
      await prisma.appExperienceRun.update({
        where: { id: runId },
        data: {
          spentUsd: { increment: selectorCost },
          carryOver: serialiseCarryOver(deterministic.context) ?? Prisma.DbNull,
        },
      });
      return concludeRun(runId, decision, reason);
    }

    // --- Route ---------------------------------------------------------------------------------
    const nextStep = stepByKey.get(decision.selectedStepKey);
    const nextVersionId = nextStep ? await resolveStepVersionId(nextStep) : null;
    if (!nextStep || !nextVersionId) {
      // The decision named a step we cannot actually run — deleted since the candidate list was
      // built, or its questionnaire has no launched version. Concluding is the only honest outcome
      // left; routing into a step that cannot run would strand the respondent.
      logger.warn('experience advance: chosen step is unrunnable; concluding', {
        runId,
        stepKey: decision.selectedStepKey,
        hasStep: Boolean(nextStep),
      });
      await prisma.appExperienceRun.update({
        where: { id: runId },
        data: {
          spentUsd: { increment: selectorCost },
          carryOver: serialiseCarryOver(deterministic.context) ?? Prisma.DbNull,
        },
      });
      return concludeRun(
        runId,
        concludeDecision(
          `The selected step "${decision.selectedStepKey}" has no runnable launched version.`
        ),
        'no_candidates'
      );
    }

    // Summarise now that the destination is known, so the bridging line can reference it.
    const carryOver = settings.summariseCarryOver
      ? await buildCarryOver({
          sessionId: completedSessionId,
          fromStepKey: sourceStep?.key ?? '',
          carryProfile: settings.carryProfile,
          summarise: true,
          next: { title: nextStep.title, purpose: nextStep.purpose },
        })
      : deterministic;

    const created = await createSessionForExperienceLeg({
      versionId: nextVersionId,
      respondentUserId: run.respondentUserId,
      cohortMemberId: run.cohortMemberId,
      roundId: nextStep.roundId,
      stepId: nextStep.id,
      fromSessionId: completedSessionId,
    });
    if (!created.ok) {
      // The chosen step cannot be run for this respondent — its version was deleted or archived,
      // it is pinned to a version that no longer exists, or a round window has closed. None of
      // those resolve by waiting.
      //
      // Conclude rather than leaving the run in `awaiting_handoff`. A stuck run means a respondent
      // who finished a questionnaire sits on a spinner until it times out and never receives a
      // report — strictly worse than ending the journey with what was already gathered. The
      // failure is logged at error level because it is always an authoring or lifecycle mistake
      // worth an operator's attention.
      logger.error('experience advance: leg session creation failed; concluding the run', {
        runId,
        stepKey: nextStep.key,
        versionId: nextVersionId,
        code: created.code,
        message: created.message,
      });
      await prisma.appExperienceRun.update({
        where: { id: runId },
        data: {
          spentUsd: { increment: selectorCost },
          carryOver: serialiseCarryOver(deterministic.context) ?? Prisma.DbNull,
        },
      });
      return concludeRun(
        runId,
        concludeDecision(
          `Could not start "${nextStep.key}" (${created.code}): ${created.message}. Concluded with what was gathered rather than leaving the respondent waiting.`
        ),
        'no_candidates'
      );
    }

    const nextOrdinal = currentLeg.ordinal + 1;
    try {
      await prisma.$transaction([
        prisma.appExperienceRunLeg.create({
          data: {
            runId,
            stepId: nextStep.id,
            sessionId: created.session.id,
            ordinal: nextOrdinal,
            status: 'active',
          },
        }),
        prisma.appExperienceRun.update({
          where: { id: runId },
          data: {
            status: 'active',
            currentStepId: nextStep.id,
            carryOver: serialiseCarryOver(carryOver.context) ?? Prisma.DbNull,
            routingDecision: { ...decision },
            spentUsd: { increment: selectorCost + carryOver.costUsd },
          },
        }),
      ]);
    } catch (err) {
      // The unique constraint arbitrates the handoff race — see the module docblock.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        logger.info('experience advance: leg already created by a concurrent call', {
          runId,
          ordinal: nextOrdinal,
        });
        return { kind: 'noop', runId };
      }
      throw err;
    }

    return {
      kind: 'leg',
      runId,
      sessionId: created.session.id,
      stepKey: nextStep.key,
      ordinal: nextOrdinal,
    };
  } catch (err) {
    logger.error('experience advance failed', {
      runId,
      completedSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'blocked',
      runId,
      code: 'STEP_UNRESOLVABLE',
      message: 'Could not advance the run',
    };
  }
}

/** The run + leg a completed session belongs to, or null when it is a standalone session. */
export async function legForSession(
  sessionId: string
): Promise<{ runId: string; ordinal: number } | null> {
  const leg = await prisma.appExperienceRunLeg.findUnique({
    where: { sessionId },
    select: { runId: true, ordinal: true },
  });
  return leg ? { runId: leg.runId, ordinal: leg.ordinal } : null;
}
