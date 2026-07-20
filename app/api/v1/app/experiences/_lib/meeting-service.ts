/**
 * Meeting service (P15.5) — the Prisma seam that applies the pure lifecycle decisions.
 *
 * `meeting/lifecycle.ts` decides WHETHER a facilitator may do something; this module does it. The
 * split is the same one `completion-logic.ts` uses, and it is what lets the rules be read and
 * tested without a database.
 *
 * ## Synthesis is fire-and-forget, never blocking
 *
 * Every write path that could trigger a synthesis returns without waiting for it. A facilitator
 * pressing "end breakout" is standing in front of a room; the room's attention is the scarce
 * resource, not the server's. The synthesis lands seconds later and the console picks it up on its
 * next poll.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { generateSessionRef } from '@/lib/app/questionnaire/session-ref';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
  BREAKOUT_ROOM_MODES,
  breakoutPhase,
  EXPERIENCE_INSIGHT_KINDS,
  EXPERIENCE_MEETING_STATUSES,
  type BreakoutRoomView,
  type MeetingInsightView,
  type MeetingLiveState,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import {
  breakoutEndsAt,
  canEndBreakout,
  canEndMeeting,
  canStartBreakout,
  canStartMeeting,
  participantWindow,
  type MeetingState,
  type ParticipantWindow,
  type TransitionDecision,
} from '@/lib/app/questionnaire/experiences/meeting/lifecycle';
import {
  applySupportGate,
  respondentVisibleInsights,
  summariseSuppression,
} from '@/lib/app/questionnaire/experiences/meeting/anonymity';
import { synthesiseBreakout } from '@/lib/app/questionnaire/experiences/meeting/synthesise';
import { buildSynthesisMaterial } from '@/lib/app/questionnaire/experiences/meeting/synthesis-material';
import { narrowRefinementHistory } from '@/lib/app/questionnaire/experiences/meeting/history';
import { resolveStepVersionId } from '@/app/api/v1/app/experiences/_lib/steps';
import { createSessionForExperienceLeg } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

/** Load just enough to make a transition decision. */
async function loadState(meetingId: string): Promise<{
  state: MeetingState;
  experienceId: string;
  settings: ReturnType<typeof narrowExperienceSettings>;
} | null> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: {
      status: true,
      currentStepId: true,
      experienceId: true,
      experience: { select: { settings: true } },
    },
  });
  if (!meeting) return null;
  return {
    state: {
      status: narrowToEnum(meeting.status, EXPERIENCE_MEETING_STATUSES, 'scheduled'),
      currentStepId: meeting.currentStepId,
    },
    experienceId: meeting.experienceId,
    settings: narrowExperienceSettings(meeting.experience.settings),
  };
}

/** Create a meeting — one occurrence of a facilitated experience. */
export async function createMeeting(params: {
  experienceId: string;
  title: string | null;
  facilitatorUserId: string;
}): Promise<{ id: string; joinRef: string }> {
  const meeting = await prisma.appExperienceMeeting.create({
    data: {
      experienceId: params.experienceId,
      // The join code that goes on the slide. Addresses the meeting; the experience's accessMode
      // still decides whether a login is needed.
      joinRef: generateSessionRef(),
      title: params.title,
      facilitatorUserId: params.facilitatorUserId,
      status: 'scheduled',
    },
    select: { id: true, joinRef: true },
  });
  return meeting;
}

/** Start the meeting — participants may join from here. */
export async function startMeeting(meetingId: string): Promise<TransitionDecision> {
  const loaded = await loadState(meetingId);
  if (!loaded) return { ok: false, code: 'MEETING_TERMINAL', message: 'Meeting not found.' };

  const decision = canStartMeeting(loaded.state);
  if (!decision.ok) return decision;

  await prisma.appExperienceMeeting.update({
    where: { id: meetingId },
    data: { status: 'live', startedAt: new Date() },
  });
  return { ok: true };
}

/**
 * Send the room into a breakout.
 *
 * `durationSeconds` is the FACILITATOR's choice for this occurrence, defaulting to the step's
 * authored length when they do not override it. The end time and the grace window are both frozen
 * here rather than derived on read, so nothing anyone edits later can move a clock the room is
 * already watching.
 */
export async function startBreakout(params: {
  meetingId: string;
  stepId: string;
  /** Null means untimed; undefined means "use the step's authored default". */
  durationSeconds?: number | null;
}): Promise<TransitionDecision> {
  const loaded = await loadState(params.meetingId);
  if (!loaded) return { ok: false, code: 'MEETING_TERMINAL', message: 'Meeting not found.' };

  const step = await prisma.appExperienceStep.findFirst({
    where: { id: params.stepId, experienceId: loaded.experienceId },
    select: { id: true, kind: true, durationSeconds: true },
  });
  if (!step) {
    return { ok: false, code: 'STEP_NOT_A_BREAKOUT', message: 'That step is not in this meeting.' };
  }

  const decision = canStartBreakout(loaded.state, step.kind);
  if (!decision.ok) return decision;

  const duration =
    params.durationSeconds === undefined ? step.durationSeconds : params.durationSeconds;
  const startedAt = new Date();

  await prisma.appExperienceMeeting.update({
    where: { id: params.meetingId },
    data: {
      currentStepId: step.id,
      breakoutStartedAt: startedAt,
      breakoutEndsAt: breakoutEndsAt(startedAt, duration),
      breakoutDurationSeconds: duration,
      breakoutGraceSeconds: loaded.settings.breakoutGraceSeconds,
    },
  });
  return { ok: true };
}

/**
 * Pull the room back.
 *
 * Sets `breakoutEndsAt` to now if the clock has not already passed, so the grace window runs from
 * this moment — "wrap up, thirty seconds" is one action rather than a cut-off. The breakout is
 * cleared only after that window, by {@link closeBreakout}.
 */
export async function endBreakout(meetingId: string): Promise<TransitionDecision> {
  const loaded = await loadState(meetingId);
  if (!loaded) return { ok: false, code: 'MEETING_TERMINAL', message: 'Meeting not found.' };

  const decision = canEndBreakout(loaded.state);
  if (!decision.ok) return decision;

  const now = new Date();
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: { breakoutEndsAt: true },
  });
  // Never EXTEND a clock: if it has already passed, ending must not push the deadline forward and
  // hand the room grace it has already used.
  const endsAt =
    meeting?.breakoutEndsAt && meeting.breakoutEndsAt < now ? meeting.breakoutEndsAt : now;

  await prisma.appExperienceMeeting.update({
    where: { id: meetingId },
    data: { breakoutEndsAt: endsAt },
  });

  // The synthesis of record for this breakout. Fire-and-forget — see the module note.
  void synthesiseAndStore(meetingId).catch((err: unknown) => {
    logger.error('meeting: synthesis after end-breakout failed', {
      meetingId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true };
}

/**
 * Clear the current breakout entirely, so the agenda can move on.
 *
 * Separate from {@link endBreakout} because they are different acts: ending starts the wrap-up,
 * closing takes the room out of it. The console calls this once the grace window has elapsed.
 */
export async function closeBreakout(meetingId: string): Promise<TransitionDecision> {
  const loaded = await loadState(meetingId);
  if (!loaded) return { ok: false, code: 'MEETING_TERMINAL', message: 'Meeting not found.' };
  if (loaded.state.currentStepId === null) {
    return { ok: false, code: 'NO_BREAKOUT_RUNNING', message: 'No breakout is running.' };
  }

  await prisma.appExperienceMeeting.update({
    where: { id: meetingId },
    data: {
      currentStepId: null,
      breakoutStartedAt: null,
      breakoutEndsAt: null,
      breakoutDurationSeconds: null,
    },
  });
  return { ok: true };
}

/** Finish the meeting, closing any open breakout first. */
export async function endMeeting(meetingId: string): Promise<TransitionDecision> {
  const loaded = await loadState(meetingId);
  if (!loaded) return { ok: false, code: 'MEETING_TERMINAL', message: 'Meeting not found.' };

  const decision = canEndMeeting(loaded.state);
  if (!decision.ok) return decision;

  await prisma.appExperienceMeeting.update({
    where: { id: meetingId },
    data: {
      status: 'ended',
      endedAt: new Date(),
      currentStepId: null,
      breakoutStartedAt: null,
      breakoutEndsAt: null,
      breakoutDurationSeconds: null,
    },
  });
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Synthesis                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Synthesise the meeting's current breakout and REPLACE its stored insights.
 *
 * Replace, not append: a synthesis is a snapshot of what the room said, and running it again after
 * more people finish should produce the current picture rather than accrete stale findings
 * alongside fresh ones. The facilitator's `covered` marks are lost on regeneration, which is the
 * honest trade — those marks referred to findings that no longer exist.
 *
 * Returns how many findings were stored and how many the gate withheld. Never throws.
 */
export async function synthesiseAndStore(
  meetingId: string
): Promise<{ stored: number; withheld: number }> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: { id: true, currentStepId: true },
  });
  if (!meeting?.currentStepId) return { stored: 0, withheld: 0 };

  // Rooms are synthesised SEPARATELY (F15.5b). They may have answered different questionnaires, so
  // combining them would resolve fills against the wrong data-slot vocabulary and silently drop
  // most of them — the same failure per-step report scoping exists to prevent. A roomless breakout
  // is the single-null-room case and takes the identical path.
  const rooms = await prisma.appExperienceBreakoutRoom.findMany({
    where: { stepId: meeting.currentStepId },
    select: { id: true },
  });
  const targets: (string | null)[] = rooms.length > 0 ? rooms.map((r) => r.id) : [null];

  let stored = 0;
  let withheld = 0;
  for (const roomId of targets) {
    const result = await synthesiseOne(meetingId, meeting.currentStepId, roomId);
    stored += result.stored;
    withheld += result.withheld;
  }
  return { stored, withheld };
}

/** Synthesise one breakout, or one room of it. */
async function synthesiseOne(
  meetingId: string,
  stepId: string,
  roomId: string | null
): Promise<{ stored: number; withheld: number }> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: { experience: { select: { settings: true } } },
  });
  if (!meeting) return { stored: 0, withheld: 0 };
  const settings = narrowExperienceSettings(meeting.experience.settings);

  const step = await prisma.appExperienceStep.findUnique({
    where: { id: stepId },
    select: {
      title: true,
      briefing: true,
      synthesisFocus: true,
      versionId: true,
      questionnaireId: true,
    },
  });
  if (!step) return { stored: 0, withheld: 0 };

  const room = roomId
    ? await prisma.appExperienceBreakoutRoom.findUnique({
        where: { id: roomId },
        select: { name: true, versionId: true, questionnaireId: true },
      })
    : null;

  // The sessions that ran THIS breakout — and this room, when there are rooms — in THIS meeting.
  const legs = await prisma.appExperienceRunLeg.findMany({
    where: { stepId, roomId, run: { meetingId } },
    select: { sessionId: true },
  });
  const sessionIds = legs.map((l) => l.sessionId);
  if (sessionIds.length === 0) return { stored: 0, withheld: 0 };

  const completed = await prisma.appQuestionnaireSession.findMany({
    where: { id: { in: sessionIds }, status: 'completed' },
    select: { id: true, versionId: true },
  });
  if (completed.length === 0) return { stored: 0, withheld: 0 };

  // The room's own version when it has one; otherwise whatever these sessions actually ran.
  const versionId = room?.versionId ?? step.versionId ?? completed[0].versionId;

  const [definitions, fills, version] = await Promise.all([
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, key: true, name: true, description: true, theme: true },
    }),
    prisma.appDataSlotFill.findMany({
      where: { sessionId: { in: completed.map((s) => s.id) } },
      select: {
        sessionId: true,
        dataSlotId: true,
        value: true,
        paraphrase: true,
        confidence: true,
        rationale: true,
        provenanceLabel: true,
        refinementHistory: true,
      },
    }),
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      select: { goal: true, questionnaire: { select: { title: true } } },
    }),
  ]);

  const slotKeyById = new Map(definitions.map((d) => [d.id, d.key]));

  const material = buildSynthesisMaterial({
    background: {
      questionnaireTitle: version?.questionnaire?.title ?? 'Questionnaire',
      goal: version?.goal ?? null,
      // Named for the room when there is one, so the synthesis says which group it describes.
      breakoutTitle: room ? `${step.title} — ${room.name}` : step.title,
      briefing: step.briefing,
      synthesisFocus: step.synthesisFocus,
    },
    definitions: definitions.map((d) => ({
      key: d.key,
      name: d.name,
      description: d.description,
      theme: d.theme,
    })),
    fills: fills
      // A fill whose slot belongs to another version cannot be placed — the same silent-drop
      // hazard the per-step report scoping exists to avoid, made explicit here.
      .filter((f) => slotKeyById.has(f.dataSlotId))
      .map((f) => ({
        sessionId: f.sessionId,
        slotKey: slotKeyById.get(f.dataSlotId) ?? '',
        value: f.value,
        paraphrase: f.paraphrase,
        confidence: f.confidence,
        rationale: f.rationale,
        provenanceLabel: f.provenanceLabel,
        refinementHistory: narrowRefinementHistory(f.refinementHistory),
      })),
    participantCount: completed.length,
  });

  const result = await synthesiseBreakout({
    material,
    minSupport: settings.insightMinSupport,
    synthesisInstructions: settings.synthesisInstructions,
    meetingId,
  });

  if (result.insights.length === 0) {
    return { stored: 0, withheld: result.withheld };
  }

  // Replace atomically so the console never renders a half-written synthesis.
  await prisma.$transaction([
    prisma.appExperienceInsight.deleteMany({ where: { meetingId, stepId, roomId } }),
    prisma.appExperienceInsight.createMany({
      data: result.insights.map((i) => ({
        meetingId,
        stepId,
        roomId,
        kind: i.kind,
        statement: i.statement,
        detail: i.detail,
        supportCount: i.supportCount,
        ordinal: i.ordinal,
        // Default to hidden. Publishing to respondents is the facilitator's editorial act, taken
        // in the room with the finding in front of them — never a side effect of generation.
        visibleToRespondents: false,
      })),
    }),
  ]);

  return { stored: result.insights.length, withheld: result.withheld };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** The live state both the console and the participant surface poll. */
export async function buildMeetingLiveState(meetingId: string): Promise<MeetingLiveState | null> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: {
      status: true,
      currentStepId: true,
      breakoutStartedAt: true,
      breakoutEndsAt: true,
      breakoutGraceSeconds: true,
      _count: { select: { runs: true } },
    },
  });
  if (!meeting) return null;

  const stepTitle = meeting.currentStepId
    ? ((
        await prisma.appExperienceStep.findUnique({
          where: { id: meeting.currentStepId },
          select: { title: true },
        })
      )?.title ?? null)
    : null;

  // "Are they done yet" — the single most-watched number on the console.
  const completedCount = meeting.currentStepId
    ? await prisma.appQuestionnaireSession.count({
        where: {
          status: 'completed',
          experienceStepId: meeting.currentStepId,
          id: {
            in: (
              await prisma.appExperienceRunLeg.findMany({
                where: { stepId: meeting.currentStepId, run: { meetingId } },
                select: { sessionId: true },
              })
            ).map((l) => l.sessionId),
          },
        },
      })
    : 0;

  return {
    status: narrowToEnum(meeting.status, EXPERIENCE_MEETING_STATUSES, 'scheduled'),
    currentStepId: meeting.currentStepId,
    currentStepTitle: stepTitle,
    breakoutStartedAt: meeting.breakoutStartedAt?.toISOString() ?? null,
    breakoutEndsAt: meeting.breakoutEndsAt?.toISOString() ?? null,
    breakoutGraceSeconds: meeting.breakoutGraceSeconds,
    participantCount: meeting._count.runs,
    completedCount,
  };
}

/** Read a meeting's insights, gated. */
export async function loadMeetingInsights(
  meetingId: string,
  audience: 'facilitator' | 'respondent'
): Promise<{ insights: MeetingInsightView[]; withheld: number }> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: { experience: { select: { settings: true } } },
  });
  if (!meeting) return { insights: [], withheld: 0 };

  const settings = narrowExperienceSettings(meeting.experience.settings);
  const rows = await prisma.appExperienceInsight.findMany({
    where: { meetingId },
    orderBy: [{ stepId: 'asc' }, { ordinal: 'asc' }],
  });

  const views: MeetingInsightView[] = rows.map((r) => ({
    id: r.id,
    stepId: r.stepId,
    kind: narrowToEnum(r.kind, EXPERIENCE_INSIGHT_KINDS, 'theme'),
    statement: r.statement,
    detail: r.detail,
    supportCount: r.supportCount,
    ordinal: r.ordinal,
    covered: r.covered,
    visibleToRespondents: r.visibleToRespondents,
  }));

  // The gate is re-applied on READ, so raising `insightMinSupport` after a meeting makes an
  // existing synthesis safer without regenerating it.
  if (audience === 'respondent') {
    // Respondents additionally need the experience to have opted in at all.
    if (!settings.surfaceInsightsToRespondents) return { insights: [], withheld: 0 };
    return {
      insights: respondentVisibleInsights(views, settings.insightMinSupport),
      // A respondent is never told how much was withheld — that count is a facilitator's
      // operational signal, and telling the room "3 findings were hidden" invites them to guess.
      withheld: 0,
    };
  }

  const { withheld } = summariseSuppression(views, settings.insightMinSupport);
  return { insights: applySupportGate(views, settings.insightMinSupport), withheld };
}

/** Mark an insight covered / uncovered as the facilitator walks the room through. */
export async function setInsightCovered(insightId: string, covered: boolean): Promise<void> {
  await prisma.appExperienceInsight.update({ where: { id: insightId }, data: { covered } });
}

/** Publish or withhold one insight from respondents. */
export async function setInsightVisible(insightId: string, visible: boolean): Promise<void> {
  await prisma.appExperienceInsight.update({
    where: { id: insightId },
    data: { visibleToRespondents: visible },
  });
}

/* -------------------------------------------------------------------------- */
/* Participants                                                               */
/* -------------------------------------------------------------------------- */

/** What a joining participant needs to start answering. */
export interface JoinResult {
  runId: string;
  /** The session for the CURRENT breakout, or null when none is running yet. */
  sessionId: string | null;
  meetingId: string;
}

/**
 * Join a meeting, or rejoin one already joined.
 *
 * Two steps, deliberately separable: a participant gets a RUN as soon as they arrive (so the
 * facilitator's "12 people are here" is true the moment they walk in), and a SESSION only once a
 * breakout is actually running. Someone who joins during the facilitator's introduction is present
 * but has nothing to answer yet, which is exactly right.
 *
 * Idempotent on both halves. A refresh, a double-tap, or two tabs must not mint a second run — the
 * room's count would drift — nor a second session for the same breakout.
 */
export async function joinMeeting(params: {
  meetingId: string;
  respondentUserId: string | null;
}): Promise<JoinResult | { error: 'NOT_LIVE' | 'NOT_FOUND' }> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: params.meetingId },
    select: { id: true, status: true, currentStepId: true, experienceId: true },
  });
  if (!meeting) return { error: 'NOT_FOUND' };

  const status = narrowToEnum(meeting.status, EXPERIENCE_MEETING_STATUSES, 'scheduled');
  // `scheduled` is refused rather than queued: someone with the link who arrives early should be
  // told the meeting has not started, not silently parked in a state nobody is watching.
  if (status !== 'live') return { error: 'NOT_LIVE' };

  // One run per participant per meeting. An authenticated respondent is matched on their user id;
  // an anonymous one cannot be recognised across requests and so always gets a fresh run — which
  // is correct, because from the room's point of view an unidentifiable rejoin IS a new person.
  const existing = params.respondentUserId
    ? await prisma.appExperienceRun.findFirst({
        where: { meetingId: meeting.id, respondentUserId: params.respondentUserId },
        select: { id: true },
      })
    : null;

  const run =
    existing ??
    (await prisma.appExperienceRun.create({
      data: {
        experienceId: meeting.experienceId,
        meetingId: meeting.id,
        respondentUserId: params.respondentUserId,
        publicRef: generateSessionRef(),
        status: 'active',
      },
      select: { id: true },
    }));

  if (!meeting.currentStepId) {
    return { runId: run.id, sessionId: null, meetingId: meeting.id };
  }

  const sessionId = await ensureBreakoutSession({
    runId: run.id,
    stepId: meeting.currentStepId,
    respondentUserId: params.respondentUserId,
  });
  return { runId: run.id, sessionId, meetingId: meeting.id };
}

/**
 * Find or create this participant's session for a breakout.
 *
 * The `@@unique([runId, ordinal])` constraint arbitrates the race rather than a read-then-write
 * check — the same decision F15.2 made at the handoff, for the same reason: a double-tapped join
 * and a poll can both land here at once, and a read-check loses. P2002 means somebody else created
 * it, which is success.
 */
async function ensureBreakoutSession(params: {
  runId: string;
  stepId: string;
  respondentUserId: string | null;
  /** The room this participant is in, when the breakout has rooms (F15.5b). */
  roomId?: string | null;
}): Promise<string | null> {
  const existing = await prisma.appExperienceRunLeg.findFirst({
    where: { runId: params.runId, stepId: params.stepId },
    select: { sessionId: true },
  });
  if (existing) return existing.sessionId;

  const step = await prisma.appExperienceStep.findUnique({
    where: { id: params.stepId },
    select: { id: true, questionnaireId: true, versionId: true, roundId: true },
  });
  if (!step) return null;

  // A room may run its OWN questionnaire; null inherits the step's, which is the common case even
  // when rooms exist — splitting a group does not always mean asking different questions.
  const room = params.roomId
    ? await prisma.appExperienceBreakoutRoom.findUnique({
        where: { id: params.roomId },
        select: { id: true, mode: true, questionnaireId: true, versionId: true },
      })
    : null;

  if (room?.mode === 'scribe') {
    // One session for the whole room. Whoever already claimed the pen owns it; everybody else is
    // present and watching, with no session of their own.
    const scribeLeg = await prisma.appExperienceRunLeg.findFirst({
      where: { stepId: params.stepId, roomId: room.id },
      select: { sessionId: true, runId: true },
    });
    if (scribeLeg) return scribeLeg.runId === params.runId ? scribeLeg.sessionId : null;
  }

  const target =
    room?.questionnaireId || room?.versionId
      ? { questionnaireId: room.questionnaireId, versionId: room.versionId }
      : step;

  const versionId = await resolveStepVersionId(target);
  if (!versionId) return null;

  const created = await createSessionForExperienceLeg({
    versionId,
    respondentUserId: params.respondentUserId,
    cohortMemberId: null,
    roundId: step.roundId,
    stepId: step.id,
    // A breakout has no predecessor to carry from: everyone starts this questionnaire fresh, at
    // the same moment. Carry-over is a switcher concept.
    fromSessionId: null,
  });
  if (!created.ok) return null;

  const ordinal = await prisma.appExperienceRunLeg.count({ where: { runId: params.runId } });
  try {
    await prisma.appExperienceRunLeg.create({
      data: {
        runId: params.runId,
        stepId: step.id,
        sessionId: created.session.id,
        roomId: params.roomId ?? null,
        ordinal,
        status: 'active',
      },
    });
    return created.session.id;
  } catch (err) {
    // Someone else won the race. Their leg is the real one; return it rather than ours.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.appExperienceRunLeg.findFirst({
        where: { runId: params.runId, stepId: params.stepId },
        select: { sessionId: true },
      });
      return winner?.sessionId ?? null;
    }
    throw err;
  }
}

/**
 * The participant's own view: where they are, and whether they may answer right now.
 *
 * Creates the leg session lazily when a breakout has started since they last polled — which is the
 * common case, since most people join before the first breakout runs.
 */
export async function participantState(params: {
  meetingId: string;
  runId: string;
}): Promise<{ sessionId: string | null; window: ParticipantWindow } | null> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: params.meetingId },
    select: {
      status: true,
      currentStepId: true,
      breakoutEndsAt: true,
      breakoutGraceSeconds: true,
    },
  });
  if (!meeting) return null;

  const run = await prisma.appExperienceRun.findFirst({
    where: { id: params.runId, meetingId: params.meetingId },
    select: { id: true, respondentUserId: true },
  });
  if (!run) return null;

  const state: MeetingState = {
    status: narrowToEnum(meeting.status, EXPERIENCE_MEETING_STATUSES, 'scheduled'),
    currentStepId: meeting.currentStepId,
  };
  const window = participantWindow(
    state,
    {
      breakoutEndsAt: meeting.breakoutEndsAt?.toISOString() ?? null,
      breakoutGraceSeconds: meeting.breakoutGraceSeconds,
    },
    new Date()
  );

  // Only mint a session when they may actually answer. Creating one during grace would hand
  // someone a blank questionnaire they have seconds to fill, which is worse than nothing.
  const sessionId =
    meeting.currentStepId && window.canAnswer
      ? await ensureBreakoutSession({
          runId: run.id,
          stepId: meeting.currentStepId,
          respondentUserId: run.respondentUserId,
        })
      : meeting.currentStepId
        ? ((
            await prisma.appExperienceRunLeg.findFirst({
              where: { runId: run.id, stepId: meeting.currentStepId },
              select: { sessionId: true },
            })
          )?.sessionId ?? null)
        : null;

  return { sessionId, window };
}

/* -------------------------------------------------------------------------- */
/* Rooms (F15.5b)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The rooms of a breakout, with live occupancy.
 *
 * `scribeTaken` matters more than it looks: a second person claiming the pen in a scribe room
 * would write into the same session as the first, overwriting each other mid-sentence. The picker
 * uses it to offer "join and watch" instead of "take the pen".
 */
export async function loadBreakoutRooms(params: {
  meetingId: string;
  stepId: string;
}): Promise<BreakoutRoomView[]> {
  const rooms = await prisma.appExperienceBreakoutRoom.findMany({
    where: { stepId: params.stepId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, name: true, ordinal: true, mode: true },
  });
  if (rooms.length === 0) return [];

  const [occupancy, scribeLegs] = await Promise.all([
    prisma.appExperienceRun.groupBy({
      by: ['currentRoomId'],
      where: { meetingId: params.meetingId, currentRoomId: { in: rooms.map((r) => r.id) } },
      _count: { _all: true },
    }),
    prisma.appExperienceRunLeg.findMany({
      where: { stepId: params.stepId, roomId: { in: rooms.map((r) => r.id) } },
      select: { roomId: true },
    }),
  ]);

  const counts = new Map(occupancy.map((o) => [o.currentRoomId, o._count._all]));
  const taken = new Set(scribeLegs.map((l) => l.roomId));

  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    ordinal: r.ordinal,
    mode: narrowToEnum(r.mode, BREAKOUT_ROOM_MODES, 'individual'),
    occupancy: counts.get(r.id) ?? 0,
    scribeTaken: taken.has(r.id),
  }));
}

/**
 * Put a participant in a room.
 *
 * In a `scribe` room this is also the act of CLAIMING the pen, if nobody holds it — the first
 * person in writes, everyone after watches. That is deliberately first-come rather than a separate
 * "become scribe" step: a room of people looking at each other deciding who types is exactly the
 * friction a facilitated breakout cannot afford.
 */
export async function chooseRoom(params: {
  meetingId: string;
  runId: string;
  roomId: string;
}): Promise<{ ok: true; sessionId: string | null } | { ok: false; code: string; message: string }> {
  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: params.meetingId },
    select: { currentStepId: true, breakoutEndsAt: true, breakoutGraceSeconds: true, status: true },
  });
  if (!meeting?.currentStepId) {
    return { ok: false, code: 'NO_BREAKOUT_RUNNING', message: 'No breakout is running.' };
  }

  const room = await prisma.appExperienceBreakoutRoom.findFirst({
    where: { id: params.roomId, stepId: meeting.currentStepId },
    select: { id: true, mode: true },
  });
  if (!room) return { ok: false, code: 'NOT_FOUND', message: 'That room is not in this breakout.' };

  const run = await prisma.appExperienceRun.findFirst({
    where: { id: params.runId, meetingId: params.meetingId },
    select: { id: true, respondentUserId: true },
  });
  if (!run) return { ok: false, code: 'NOT_FOUND', message: 'You are not in this meeting.' };

  // Only while genuinely running — see `canChooseRoom`. Arriving at a room with seconds left, to a
  // questionnaire you have not started, is worse than being told you missed it.
  const phase = breakoutPhase(
    meeting.breakoutEndsAt?.toISOString() ?? null,
    meeting.breakoutGraceSeconds,
    new Date()
  );
  if (phase !== 'running') {
    return { ok: false, code: 'BREAKOUT_CLOSED', message: 'That breakout has finished.' };
  }

  await prisma.appExperienceRun.update({
    where: { id: run.id },
    data: { currentRoomId: room.id },
  });

  const sessionId = await ensureBreakoutSession({
    runId: run.id,
    stepId: meeting.currentStepId,
    respondentUserId: run.respondentUserId,
    roomId: room.id,
  });

  // Null in a scribe room where somebody else holds the pen — they are in, and watching.
  return { ok: true, sessionId };
}
