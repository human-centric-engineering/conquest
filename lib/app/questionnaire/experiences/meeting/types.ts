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
  /** How many participants have joined this meeting at all. */
  participantCount: number;
  /** How many have COMPLETED the current breakout — the facilitator's "are they done yet". */
  completedCount: number;
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
