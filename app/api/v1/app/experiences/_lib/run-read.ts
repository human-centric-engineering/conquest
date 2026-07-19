/**
 * Experience run read models.
 *
 * Two very different consumers, hence two shapes:
 *
 *  - `buildRunPollState` serves the RESPONDENT's poll loop. It must stay cheap — a run of eight
 *    people polling every 1.5s is real load — so it reads only the run row and its newest leg, and
 *    never triggers work.
 *  - `getRunDetail` serves the ADMIN runs console, where the routing rationale and per-leg history
 *    are the point.
 */

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { narrowCarryOver } from '@/lib/app/questionnaire/experiences/carryover/narrow';
import {
  CONCLUDE_REASONS,
  EXPERIENCE_LEG_STATUSES,
  EXPERIENCE_RUN_STATUSES,
  type ExperienceLegStatus,
  type ExperienceRunStatus,
  type RunPollState,
} from '@/lib/app/questionnaire/experiences/run/types';
import {
  ROUTING_DECISIONS,
  ROUTING_SOURCES,
  type RoutingDecisionKind,
  type RoutingSource,
} from '@/lib/app/questionnaire/experiences/types';
import { isRecord } from '@/lib/utils';

/** The respondent-facing line when a run concluded but no message was recorded. */
const DEFAULT_CONCLUDE_MESSAGE =
  "Thanks — that's everything I need. I'm putting your summary together now.";

/** The respondent-facing line when routing onward but no message was recorded. */
const DEFAULT_CONTINUE_MESSAGE = "Thanks — there's one more area I'd like to explore with you.";

/**
 * The poll answer for a run.
 *
 * `pending` covers both "still running the entry leg" and "the selector has not resolved yet" —
 * from the client's point of view these are the same instruction: keep waiting. Anything else is
 * terminal for the poll loop.
 *
 * Never triggers an advance. A poll that could cause work would let a page refresh double-fire the
 * handoff, which is exactly what the idempotency constraint exists to make impossible.
 */
export async function buildRunPollState(
  runId: string,
  /** The leg the client already knows about — so a newly-created later leg is recognised. */
  knownSessionId?: string
): Promise<RunPollState | null> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      routingDecision: true,
      legs: {
        orderBy: { ordinal: 'desc' },
        take: 1,
        select: { sessionId: true, ordinal: true, stepId: true },
      },
    },
  });
  if (!run) return null;

  const status = narrowToEnum(run.status, EXPERIENCE_RUN_STATUSES, 'active');
  const decision = isRecord(run.routingDecision) ? run.routingDecision : null;
  const message =
    typeof decision?.respondentMessage === 'string' && decision.respondentMessage.trim() !== ''
      ? decision.respondentMessage
      : null;

  if (status === 'completed') {
    const rawReason = typeof decision?.concludeReason === 'string' ? decision.concludeReason : '';
    return {
      state: 'conclude',
      reason: narrowToEnum(rawReason, CONCLUDE_REASONS, 'selector'),
      message: message ?? DEFAULT_CONCLUDE_MESSAGE,
    };
  }

  if (status === 'abandoned' || status === 'aborted') {
    return { state: 'failed', message: 'This journey is no longer active.' };
  }

  const newest = run.legs[0];
  // A new leg exists that the client has not seen — that is the handoff resolving.
  if (newest && newest.sessionId !== knownSessionId) {
    const step = await prisma.appExperienceStep.findUnique({
      where: { id: newest.stepId },
      select: { title: true },
    });
    return {
      state: 'leg',
      sessionId: newest.sessionId,
      stepTitle: step?.title ?? 'Next questions',
      message: message ?? DEFAULT_CONTINUE_MESSAGE,
    };
  }

  return { state: 'pending' };
}

/** One leg, as the admin runs console renders it. */
export interface RunLegView {
  ordinal: number;
  stepId: string;
  stepKey: string | null;
  stepTitle: string | null;
  sessionId: string;
  sessionRef: string | null;
  status: ExperienceLegStatus;
  startedAt: string;
  completedAt: string | null;
}

/** The routing decision, narrowed for display. */
export interface RunDecisionView {
  decision: RoutingDecisionKind;
  selectedStepKey: string | null;
  confidence: number | null;
  rationale: string | null;
  source: RoutingSource;
}

/** One run, as the admin runs console renders it. */
export interface RunDetailView {
  id: string;
  experienceId: string;
  publicRef: string | null;
  status: ExperienceRunStatus;
  spentUsd: number;
  startedAt: string;
  completedAt: string | null;
  legs: RunLegView[];
  decision: RunDecisionView | null;
  /** Short summary of what was carried at the most recent handoff. */
  carriedThemes: string[];
  briefing: string | null;
}

function narrowDecision(value: unknown): RunDecisionView | null {
  if (!isRecord(value)) return null;
  return {
    decision: narrowToEnum(
      typeof value.decision === 'string' ? value.decision : '',
      ROUTING_DECISIONS,
      'conclude'
    ),
    selectedStepKey: typeof value.selectedStepKey === 'string' ? value.selectedStepKey : null,
    confidence:
      typeof value.confidence === 'number' && Number.isFinite(value.confidence)
        ? value.confidence
        : null,
    rationale: typeof value.rationale === 'string' ? value.rationale : null,
    source: narrowToEnum(
      typeof value.source === 'string' ? value.source : '',
      ROUTING_SOURCES,
      'llm'
    ),
  };
}

/** Load one run with its legs, resolving step titles and session refs in two batched queries. */
export async function getRunDetail(runId: string): Promise<RunDetailView | null> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      experienceId: true,
      publicRef: true,
      status: true,
      spentUsd: true,
      startedAt: true,
      completedAt: true,
      routingDecision: true,
      carryOver: true,
      legs: {
        orderBy: { ordinal: 'asc' },
        select: {
          ordinal: true,
          stepId: true,
          sessionId: true,
          status: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });
  if (!run) return null;

  // Batched, never per-leg — the no-N+1 rule holds on admin surfaces too.
  const [steps, sessions] = await Promise.all([
    prisma.appExperienceStep.findMany({
      where: { id: { in: run.legs.map((l) => l.stepId) } },
      select: { id: true, key: true, title: true },
    }),
    prisma.appQuestionnaireSession.findMany({
      where: { id: { in: run.legs.map((l) => l.sessionId) } },
      select: { id: true, publicRef: true },
    }),
  ]);
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const refById = new Map(sessions.map((s) => [s.id, s.publicRef]));

  const carryOver = narrowCarryOver(run.carryOver);

  return {
    id: run.id,
    experienceId: run.experienceId,
    publicRef: run.publicRef,
    status: narrowToEnum(run.status, EXPERIENCE_RUN_STATUSES, 'active'),
    spentUsd: run.spentUsd,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    legs: run.legs.map((leg) => ({
      ordinal: leg.ordinal,
      stepId: leg.stepId,
      // A step deleted after the run took it renders as "missing" rather than breaking the page —
      // the pointer is unmodelled by design, so this is expected, not exceptional.
      stepKey: stepById.get(leg.stepId)?.key ?? null,
      stepTitle: stepById.get(leg.stepId)?.title ?? null,
      sessionId: leg.sessionId,
      sessionRef: refById.get(leg.sessionId) ?? null,
      status: narrowToEnum(leg.status, EXPERIENCE_LEG_STATUSES, 'active'),
      startedAt: leg.startedAt.toISOString(),
      completedAt: leg.completedAt?.toISOString() ?? null,
    })),
    decision: narrowDecision(run.routingDecision),
    carriedThemes: carryOver?.carriedThemes ?? [],
    briefing: carryOver?.briefing ?? null,
  };
}

/** Runs for an experience, newest-first, with just enough for the admin list. */
export async function listRunsForExperience(
  experienceId: string,
  limit = 100
): Promise<
  Array<{
    id: string;
    publicRef: string | null;
    status: ExperienceRunStatus;
    legCount: number;
    spentUsd: number;
    startedAt: string;
    completedAt: string | null;
    decisionSource: RoutingSource | null;
    selectedStepKey: string | null;
  }>
> {
  const runs = await prisma.appExperienceRun.findMany({
    where: { experienceId },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      publicRef: true,
      status: true,
      spentUsd: true,
      startedAt: true,
      completedAt: true,
      routingDecision: true,
      _count: { select: { legs: true } },
    },
  });

  return runs.map((run) => {
    const decision = narrowDecision(run.routingDecision);
    return {
      id: run.id,
      publicRef: run.publicRef,
      status: narrowToEnum(run.status, EXPERIENCE_RUN_STATUSES, 'active'),
      legCount: run._count.legs,
      spentUsd: run.spentUsd,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      decisionSource: decision?.source ?? null,
      selectedStepKey: decision?.selectedStepKey ?? null,
    };
  });
}
