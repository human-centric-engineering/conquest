/**
 * Facilitated meetings (P15.5) — pure domain types.
 *
 * A MEETING is one live occurrence of a facilitated experience: a group of people doing this
 * together, right now. A BREAKOUT is a period of TIME within it — participants go and have their
 * own chats against a questionnaire, then the answers are aggregated and synthesised for the
 * facilitator to walk the room through.
 *
 * No Prisma, no Next — safe to import from client components.
 */

/**
 * A meeting's lifecycle.
 *
 * `scheduled` — created, join link shareable, nobody sent anywhere yet.
 * `live`      — the facilitator has started it; participants can join.
 * `ended`     — the agenda is done. Terminal, and the state the synthesis is read in afterwards.
 * `abandoned` — closed without finishing. Terminal.
 *
 * Deliberately NOT mirroring `EXPERIENCE_RUN_STATUSES`: a run has `awaiting_handoff`, which has no
 * meaning here, and a meeting has `scheduled`, which has none there. Forcing one vocabulary onto
 * both would make each carry a state it can never enter.
 */
export const EXPERIENCE_MEETING_STATUSES = ['scheduled', 'live', 'ended', 'abandoned'] as const;
export type ExperienceMeetingStatus = (typeof EXPERIENCE_MEETING_STATUSES)[number];

/** Statuses a meeting can still move on from. */
const LIVE_MEETING_STATUSES: readonly ExperienceMeetingStatus[] = ['scheduled', 'live'];

/** Whether a meeting has reached a state it can never leave. */
export function isTerminalMeetingStatus(status: ExperienceMeetingStatus): boolean {
  return !LIVE_MEETING_STATUSES.includes(status);
}

/** Human labels for the meeting status. */
export const EXPERIENCE_MEETING_STATUS_LABELS: Record<ExperienceMeetingStatus, string> = {
  scheduled: 'Not started',
  live: 'In progress',
  ended: 'Finished',
  abandoned: 'Abandoned',
};

/**
 * What a synthesised finding IS.
 *
 * The set is deliberately small and facilitation-shaped rather than analytics-shaped: each kind
 * answers a question a facilitator actually asks a room out loud. A longer taxonomy would produce
 * findings nobody knows what to do with when they are standing at the front.
 */
export const EXPERIENCE_INSIGHT_KINDS = [
  /** Most people said the same thing. The room can move on. */
  'agreement',
  /** People disagreed in a way worth surfacing. Usually the most valuable minutes of a meeting. */
  'tension',
  /** A minority position that deserves air despite being outnumbered. */
  'outlier',
  /** A recurring subject, without a position attached. */
  'theme',
  /** Something the room does not yet know and should decide how to find out. */
  'question',
] as const;
export type ExperienceInsightKind = (typeof EXPERIENCE_INSIGHT_KINDS)[number];

/** Human labels for the insight kinds — the facilitator's own vocabulary. */
export const EXPERIENCE_INSIGHT_KIND_LABELS: Record<ExperienceInsightKind, string> = {
  agreement: 'Agreement',
  tension: 'Tension',
  outlier: 'Outlier',
  theme: 'Theme',
  question: 'Open question',
};

/**
 * Bounds on a breakout's authored duration.
 *
 * Floored at a minute because anything shorter cannot fit a conversation, and capped at two hours
 * because a breakout longer than that is not a breakout — it is the meeting.
 */
export const BREAKOUT_MIN_DURATION_SECONDS = 60;
export const BREAKOUT_MAX_DURATION_SECONDS = 2 * 60 * 60;

/** Bounds on the breakout free-text fields. */
export const BREAKOUT_BRIEFING_MAX_LENGTH = 2_000;
export const BREAKOUT_SYNTHESIS_FOCUS_MAX_LENGTH = 2_000;

/**
 * One insight as the facilitator's walkthrough renders it.
 *
 * `supportCount` is present so the facilitator can weigh a finding ("four of you said this"), and
 * because the k-anonymity gate is re-applied on READ — an admin who raises `insightMinSupport`
 * after a meeting makes the existing synthesis safer without regenerating it.
 */
export interface MeetingInsightView {
  id: string;
  stepId: string;
  kind: ExperienceInsightKind;
  statement: string;
  detail: string | null;
  supportCount: number;
  ordinal: number;
  covered: boolean;
  visibleToRespondents: boolean;
}

/**
 * The live state of a meeting, as the facilitator console and the participant surface both poll.
 *
 * One shape for both audiences, filtered on the server: the facilitator gets the insights, the
 * participant gets only those marked visible. Two shapes would drift on the field that matters
 * most — which insights are safe to show.
 */
export interface MeetingLiveState {
  status: ExperienceMeetingStatus;
  /** The breakout currently running, or null between breakouts. */
  currentStepId: string | null;
  currentStepTitle: string | null;
  /** The live clock (ISO), or null when no breakout is running. */
  breakoutStartedAt: string | null;
  breakoutEndsAt: string | null;
  /**
   * The grace window frozen at breakout start. Sent to the client so it can render the countdown
   * itself every tick without a request, and reach the same answer the server would.
   */
  breakoutGraceSeconds: number;
  /** How many participants have joined this meeting at all. */
  participantCount: number;
  /** How many have COMPLETED the current breakout — the facilitator's "are they done yet". */
  completedCount: number;
}

/**
 * Where a breakout is in its life, right now.
 *
 * `running` — the clock is going; people are answering.
 * `grace`   — the clock has ended and the grace window has not. People may FINISH and submit what
 *             they are mid-way through. Nothing new should be started.
 * `closed`  — both have passed. No further submissions.
 *
 * The middle phase exists because the clock ending and the room being done are not the same
 * moment. Cutting someone off mid-sentence loses the answer and the goodwill; thirty seconds costs
 * the meeting nothing. An untimed breakout is always `running` until the facilitator ends it.
 */
export const BREAKOUT_PHASES = ['running', 'grace', 'closed'] as const;
export type BreakoutPhase = (typeof BREAKOUT_PHASES)[number];

/**
 * Which phase a breakout is in.
 *
 * `endsAt` null means untimed — always `running`, because only the facilitator closes it. Both
 * boundaries are exclusive-of-the-past: exactly AT `endsAt` is still `running`, and exactly at the
 * grace boundary is still `grace`, so nobody loses a submission to a rounding edge.
 */
export function breakoutPhase(
  endsAt: string | null,
  graceSeconds: number,
  now: Date
): BreakoutPhase {
  if (!endsAt) return 'running';
  const end = new Date(endsAt).getTime();
  // An unparseable clock must not silently close a live breakout — treat it as untimed.
  if (Number.isNaN(end)) return 'running';

  const t = now.getTime();
  if (t <= end) return 'running';
  const graceEnd = end + Math.max(0, graceSeconds) * 1000;
  return t <= graceEnd ? 'grace' : 'closed';
}

/**
 * Seconds left in the GRACE window, or null when not in it.
 *
 * Drives the respondent's "finish up — 24 seconds" line. Separate from {@link secondsRemaining},
 * which counts the main clock: a single countdown that silently rolled from one into the other
 * would tell someone they had 30 seconds left when what they actually had was 30 seconds to submit
 * — a different instruction.
 */
export function graceSecondsRemaining(
  endsAt: string | null,
  graceSeconds: number,
  now: Date
): number | null {
  if (breakoutPhase(endsAt, graceSeconds, now) !== 'grace' || !endsAt) return null;
  const graceEnd = new Date(endsAt).getTime() + Math.max(0, graceSeconds) * 1000;
  return Math.max(0, Math.round((graceEnd - now.getTime()) / 1000));
}

/**
 * Seconds left on a breakout clock, or null when it is untimed / not running.
 *
 * Pure so the client can recompute every tick without a request, and so the server can render the
 * same number. Never negative: an overrun reads as 0, because "-3:12 remaining" is not a thing a
 * facilitator needs to see and the console shows an explicit overrun state instead.
 */
export function secondsRemaining(endsAt: string | null, now: Date): number | null {
  if (!endsAt) return null;
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - now.getTime()) / 1000));
}

/**
 * Whether a timed breakout has run past its clock.
 *
 * Distinct from `secondsRemaining() === 0`, which is also true for the instant it hits zero. The
 * console needs "the room is over time" as its own state, because that is when a facilitator
 * decides whether to pull people back.
 */
export function isOverrunning(endsAt: string | null, now: Date): boolean {
  if (!endsAt) return false;
  const end = new Date(endsAt).getTime();
  return !Number.isNaN(end) && now.getTime() > end;
}

/* -------------------------------------------------------------------------- */
/* Breakout rooms (F15.5b)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How a room works.
 *
 * `individual` — everyone in the room answers their own copy. The room is a grouping for the
 * synthesis; each person still has their own conversation.
 * `scribe` — ONE session represents the whole room, driven by whoever claims the pen. The others
 * are present and watching, and deliberately have no session: a room that talks an answer through
 * together has one answer, not six, and six near-identical copies would also make the k-anonymity
 * support counts meaningless.
 */
export const BREAKOUT_ROOM_MODES = ['individual', 'scribe'] as const;
export type BreakoutRoomMode = (typeof BREAKOUT_ROOM_MODES)[number];

/** Human labels for the room-mode selector. */
export const BREAKOUT_ROOM_MODE_LABELS: Record<BreakoutRoomMode, string> = {
  individual: 'Everyone answers their own',
  scribe: 'One person writes for the room',
};

/** One room, as the participant's picker and the facilitator's console render it. */
export interface BreakoutRoomView {
  id: string;
  name: string;
  ordinal: number;
  mode: BreakoutRoomMode;
  /** How many participants have chosen this room. */
  occupancy: number;
  /**
   * Whether someone already holds the pen. Scribe rooms only; a second person cannot claim it,
   * because two people writing the same answer would overwrite each other mid-sentence.
   */
  scribeTaken: boolean;
}

/**
 * What a participant may do about rooms right now.
 *
 * Choosing a room is only meaningful while a breakout with rooms is running — before that there is
 * nothing to join, and afterwards the answers are already given.
 */
export function canChooseRoom(params: {
  breakoutRunning: boolean;
  phase: BreakoutPhase;
  hasRooms: boolean;
}): boolean {
  // Deliberately excludes `grace`: arriving at a room with seconds left, to a questionnaire you
  // have not started, is worse than being told you missed it.
  return params.breakoutRunning && params.hasRooms && params.phase === 'running';
}
