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
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { narrowCarryOver } from '@/lib/app/questionnaire/experiences/carryover/narrow';
import {
  CONCLUDE_REASONS,
  EXPERIENCE_LEG_STATUSES,
  EXPERIENCE_RUN_STATUSES,
  type ExperienceLegStatus,
  type ExperienceRunStatus,
  type RunPollState,
  type SessionExperienceContext,
  type StitchedHistory,
  type StitchedSegment,
} from '@/lib/app/questionnaire/experiences/run/types';
import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
  EXPERIENCE_CONTINUITY_MODES,
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
  knownSessionId?: string,
  /**
   * Mint an access token for a newly-revealed leg. Set ONLY when the caller proved ownership with
   * a valid session token (the no-login surface), never for a cookie-authenticated respondent —
   * they do not need one, and issuing a bearer credential nobody asked for widens the surface for
   * no gain.
   */
  mintTokenForNewLeg = false
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
      ...(mintTokenForNewLeg ? { sessionToken: mintSessionToken(newest.sessionId).token } : {}),
    };
  }

  return { state: 'pending' };
}

/**
 * Whether this session is a leg of an experience run, and how its seam should be presented.
 *
 * Called on every session-status read, including the vast majority that are standalone sessions —
 * so the miss path must be one indexed lookup and nothing more. It is: `sessionId` is `@unique` on
 * the leg table, and a null result short-circuits before the second query.
 *
 * The continuity mode is read LIVE from the experience rather than frozen onto the run. That is
 * deliberate and follows from the invariant that `linked` and `stitched` share a persistence
 * shape: an author who switches modes mid-flight changes what in-flight respondents see, which is
 * the point of the two modes being presentation-only.
 */
export async function experienceContextForSession(
  sessionId: string
): Promise<SessionExperienceContext | null> {
  const leg = await prisma.appExperienceRunLeg.findUnique({
    where: { sessionId },
    select: {
      runId: true,
      ordinal: true,
      stepId: true,
      run: {
        select: {
          publicRef: true,
          experience: { select: { continuityMode: true, settings: true } },
        },
      },
    },
  });
  if (!leg) return null;

  // The step pointer is unmodelled (UG-1), so a step deleted after the run took it resolves to
  // null and the divider falls back to generic copy. Never throw on a dangling pointer.
  const step = await prisma.appExperienceStep.findUnique({
    where: { id: leg.stepId },
    select: { title: true },
  });

  const settings = narrowExperienceSettings(leg.run.experience.settings);
  return {
    runId: leg.runId,
    publicRef: leg.run.publicRef,
    ordinal: leg.ordinal,
    continuityMode: narrowToEnum(
      leg.run.experience.continuityMode,
      EXPERIENCE_CONTINUITY_MODES,
      'linked'
    ),
    seamMarker: settings.stitchedSeamMarker,
    stepTitle: step?.title ?? null,
  };
}

/**
 * Replay every leg of a run that came BEFORE the given session, oldest first (P15.3).
 *
 * What makes one continuous chat out of two sessions. Strictly a READ — no rows are written,
 * merged or rewritten, which is the whole reason `stitched` and `linked` can share a persistence
 * shape and an experience can be switched between them mid-flight.
 *
 * Returns empty for the entry leg (nothing precedes it) and for a session that is not part of a
 * run at all. Step titles resolve in one batched query; a dangling step pointer renders as a
 * generic divider rather than throwing.
 */
export async function loadStitchedHistory(
  runId: string,
  currentSessionId: string
): Promise<StitchedHistory> {
  const legs = await prisma.appExperienceRunLeg.findMany({
    where: { runId },
    orderBy: { ordinal: 'asc' },
    select: { ordinal: true, stepId: true, sessionId: true },
  });

  const current = legs.find((l) => l.sessionId === currentSessionId);
  // A session that is not a leg of this run gets no history. Callers gate on ownership before
  // reaching here, but returning empty rather than everything keeps the failure mode closed.
  if (!current) return { segments: [] };

  const prior = legs.filter((l) => l.ordinal < current.ordinal);
  if (prior.length === 0) return { segments: [] };

  const steps = await prisma.appExperienceStep.findMany({
    where: { id: { in: prior.map((l) => l.stepId) } },
    select: { id: true, title: true },
  });
  const titleById = new Map(steps.map((s) => [s.id, s.title]));

  // Sequential rather than Promise.all: a run has a handful of legs, and each `loadTranscript` is
  // itself a query returning every turn of a conversation. Fanning them out buys nothing and
  // makes the worst case (a long journey being replayed) spikier on the connection pool.
  const segments: StitchedSegment[] = [];
  for (const leg of prior) {
    segments.push({
      stepTitle: titleById.get(leg.stepId) ?? null,
      turns: await loadTranscript(leg.sessionId),
    });
  }
  return { segments };
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
