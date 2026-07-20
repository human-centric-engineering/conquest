/**
 * Meeting lifecycle transitions (P15.5) — pure decisions about what a facilitator may do next.
 *
 * Separated from the Prisma write seam for the same reason `completion-logic.ts` is: the rules of
 * "can this meeting start a breakout right now" are worth reading, testing and reasoning about
 * without a database. The service layer applies whatever this decides.
 *
 * ## The facilitator drives, the clock does not
 *
 * A breakout is a period of TIME, but the timer is an aid to the person running the room, never an
 * authority over it. It is what a facilitator sees and what participants see; it does NOT end the
 * breakout by itself. A room that runs three minutes over is normal facilitation, and a system
 * that closed the questionnaire mid-sentence because a clock expired would be actively hostile.
 *
 * Hence `isOverrunning` is a DISPLAY state, and only an explicit `endBreakout` closes one.
 */

import {
  breakoutPhase,
  isTerminalMeetingStatus,
  type ExperienceMeetingStatus,
} from '@/lib/app/questionnaire/experiences/meeting/types';

/** The meeting state a transition decision reads. */
export interface MeetingState {
  status: ExperienceMeetingStatus;
  currentStepId: string | null;
}

/** Why a transition was refused. Machine-readable; the route maps it to a 409. */
export const MEETING_TRANSITION_ERRORS = [
  'MEETING_TERMINAL',
  'MEETING_NOT_LIVE',
  'MEETING_ALREADY_LIVE',
  'BREAKOUT_ALREADY_RUNNING',
  'NO_BREAKOUT_RUNNING',
  'STEP_NOT_A_BREAKOUT',
] as const;
export type MeetingTransitionError = (typeof MEETING_TRANSITION_ERRORS)[number];

export type TransitionDecision =
  { ok: true } | { ok: false; code: MeetingTransitionError; message: string };

const refuse = (code: MeetingTransitionError, message: string): TransitionDecision => ({
  ok: false,
  code,
  message,
});

/** Start the meeting — participants may join from this point. */
export function canStartMeeting(state: MeetingState): TransitionDecision {
  if (isTerminalMeetingStatus(state.status)) {
    return refuse('MEETING_TERMINAL', 'This meeting has already finished.');
  }
  if (state.status === 'live') {
    return refuse('MEETING_ALREADY_LIVE', 'This meeting is already running.');
  }
  return { ok: true };
}

/**
 * Send the room into a breakout.
 *
 * Refuses while another breakout is running rather than silently switching. Two breakouts open at
 * once would split the room's answers across questionnaires with no way to tell afterwards which
 * period a given answer belonged to — and the synthesis is scoped per breakout.
 */
export function canStartBreakout(state: MeetingState, stepKind: string): TransitionDecision {
  if (isTerminalMeetingStatus(state.status)) {
    return refuse('MEETING_TERMINAL', 'This meeting has already finished.');
  }
  if (state.status !== 'live') {
    return refuse('MEETING_NOT_LIVE', 'Start the meeting before running a breakout.');
  }
  if (state.currentStepId !== null) {
    return refuse(
      'BREAKOUT_ALREADY_RUNNING',
      'A breakout is already running. End it before starting the next one.'
    );
  }
  if (stepKind !== 'breakout') {
    return refuse('STEP_NOT_A_BREAKOUT', 'That step is not a breakout.');
  }
  return { ok: true };
}

/**
 * Pull the room back.
 *
 * Always allowed while one is running, including before the clock expires — a facilitator who can
 * see the room is done should not have to wait out a timer.
 */
export function canEndBreakout(state: MeetingState): TransitionDecision {
  if (isTerminalMeetingStatus(state.status)) {
    return refuse('MEETING_TERMINAL', 'This meeting has already finished.');
  }
  if (state.currentStepId === null) {
    return refuse('NO_BREAKOUT_RUNNING', 'No breakout is running.');
  }
  return { ok: true };
}

/**
 * Finish the meeting.
 *
 * Permitted with a breakout still open: the service closes it first. A facilitator ending a
 * meeting has already moved on, and refusing until they tidied up would be pedantry that leaves
 * meetings stuck `live` forever.
 */
export function canEndMeeting(state: MeetingState): TransitionDecision {
  if (isTerminalMeetingStatus(state.status)) {
    return refuse('MEETING_TERMINAL', 'This meeting has already finished.');
  }
  return { ok: true };
}

/**
 * When a breakout started now would be due to end.
 *
 * Computed once at START and stored, never derived on read: an author editing the step's duration
 * mid-meeting must not retroactively move a clock the room is already watching. Null for an
 * untimed breakout, which the facilitator ends by hand.
 */
export function breakoutEndsAt(startedAt: Date, durationSeconds: number | null): Date | null {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  return new Date(startedAt.getTime() + durationSeconds * 1000);
}

/** What a participant is allowed to do right now. */
export interface ParticipantWindow {
  /** May they send a new turn / start a new answer? */
  canAnswer: boolean;
  /** May they submit what they already have? True through the grace window as well. */
  canSubmit: boolean;
  /** True during grace — the surface says "finish up" rather than "time's up". */
  wrappingUp: boolean;
}

const SHUT: ParticipantWindow = { canAnswer: false, canSubmit: false, wrappingUp: false };

/**
 * What a participant may do in this meeting, right now.
 *
 * Answering and submitting are separated deliberately. When the clock ends, the grace window lets
 * someone FINISH and send what they are mid-way through — but not begin something new, because a
 * fresh answer started after the bell will not be part of the conversation the room is about to
 * discuss. Cutting off both at once loses answers people had already written.
 *
 * Between breakouts the window is shut entirely: the room is listening to the facilitator, and an
 * answer arriving then would land in whichever breakout started next, corrupting a synthesis that
 * is scoped per period.
 */
export function participantWindow(
  state: MeetingState,
  clock: { breakoutEndsAt: string | null; breakoutGraceSeconds: number },
  now: Date
): ParticipantWindow {
  if (state.status !== 'live' || state.currentStepId === null) return SHUT;

  const phase = breakoutPhase(clock.breakoutEndsAt, clock.breakoutGraceSeconds, now);
  switch (phase) {
    case 'running':
      return { canAnswer: true, canSubmit: true, wrappingUp: false };
    case 'grace':
      return { canAnswer: false, canSubmit: true, wrappingUp: true };
    case 'closed':
      return SHUT;
  }
}

/**
 * Whether a participant may answer at all — the coarse gate.
 *
 * Kept as a named predicate because "is this meeting open for answers" is asked in places that do
 * not care about the grace distinction. Anything rendering a composer or accepting a submit should
 * use {@link participantWindow} instead, which knows the difference.
 */
export function canParticipantAnswer(state: MeetingState): boolean {
  return state.status === 'live' && state.currentStepId !== null;
}
