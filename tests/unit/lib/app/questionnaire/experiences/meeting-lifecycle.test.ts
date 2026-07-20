/**
 * Meeting lifecycle transitions (P15.5).
 *
 * The rules a facilitator runs a room by. The recurring theme under test: the facilitator drives
 * and the clock advises — a timer never closes a breakout on its own.
 */

import { describe, it, expect } from 'vitest';

import {
  breakoutEndsAt,
  canEndBreakout,
  canEndMeeting,
  canParticipantAnswer,
  canStartBreakout,
  canStartMeeting,
  type MeetingState,
} from '@/lib/app/questionnaire/experiences/meeting/lifecycle';
import { isOverrunning, secondsRemaining } from '@/lib/app/questionnaire/experiences/meeting/types';

function state(over: Partial<MeetingState> = {}): MeetingState {
  return { status: 'live', currentStepId: null, ...over };
}

describe('canStartMeeting', () => {
  it('allows a scheduled meeting to start', () => {
    expect(canStartMeeting(state({ status: 'scheduled' })).ok).toBe(true);
  });

  it('refuses to restart a live meeting', () => {
    const d = canStartMeeting(state({ status: 'live' }));
    expect(d).toMatchObject({ ok: false, code: 'MEETING_ALREADY_LIVE' });
  });

  it.each(['ended', 'abandoned'] as const)('refuses a %s meeting', (status) => {
    expect(canStartMeeting(state({ status }))).toMatchObject({
      ok: false,
      code: 'MEETING_TERMINAL',
    });
  });
});

describe('canStartBreakout', () => {
  it('allows a breakout when the meeting is live and nothing is running', () => {
    expect(canStartBreakout(state(), 'breakout').ok).toBe(true);
  });

  it('refuses before the meeting has started', () => {
    expect(canStartBreakout(state({ status: 'scheduled' }), 'breakout')).toMatchObject({
      ok: false,
      code: 'MEETING_NOT_LIVE',
    });
  });

  it('refuses a SECOND concurrent breakout', () => {
    // Two open at once would split the room's answers across questionnaires with no way to tell
    // afterwards which period an answer belonged to — and synthesis is scoped per breakout.
    expect(canStartBreakout(state({ currentStepId: 'step_1' }), 'breakout')).toMatchObject({
      ok: false,
      code: 'BREAKOUT_ALREADY_RUNNING',
    });
  });

  it.each(['entry', 'branch', 'report'])('refuses a %s step', (kind) => {
    expect(canStartBreakout(state(), kind)).toMatchObject({
      ok: false,
      code: 'STEP_NOT_A_BREAKOUT',
    });
  });
});

describe('canEndBreakout', () => {
  it('allows ending a running breakout', () => {
    expect(canEndBreakout(state({ currentStepId: 'step_1' })).ok).toBe(true);
  });

  it('allows ending EARLY — the facilitator need not wait out the clock', () => {
    // A facilitator who can see the room is done should not be held by a timer.
    expect(canEndBreakout(state({ currentStepId: 'step_1' })).ok).toBe(true);
  });

  it('refuses when nothing is running', () => {
    expect(canEndBreakout(state())).toMatchObject({ ok: false, code: 'NO_BREAKOUT_RUNNING' });
  });
});

describe('canEndMeeting', () => {
  it('allows ending with a breakout still open — the service closes it first', () => {
    // Refusing until the facilitator tidied up would be pedantry that leaves meetings stuck live.
    expect(canEndMeeting(state({ currentStepId: 'step_1' })).ok).toBe(true);
  });

  it('allows ending a meeting that never started', () => {
    expect(canEndMeeting(state({ status: 'scheduled' })).ok).toBe(true);
  });

  it('refuses an already-finished meeting', () => {
    expect(canEndMeeting(state({ status: 'ended' }))).toMatchObject({
      ok: false,
      code: 'MEETING_TERMINAL',
    });
  });
});

describe('breakoutEndsAt', () => {
  const started = new Date('2026-08-14T14:03:00.000Z');

  it('adds the authored duration to the start moment', () => {
    expect(breakoutEndsAt(started, 12 * 60)?.toISOString()).toBe('2026-08-14T14:15:00.000Z');
  });

  it('is null for an untimed breakout', () => {
    expect(breakoutEndsAt(started, null)).toBeNull();
  });

  it('treats a non-positive duration as untimed rather than instantly expired', () => {
    expect(breakoutEndsAt(started, 0)).toBeNull();
    expect(breakoutEndsAt(started, -60)).toBeNull();
  });
});

describe('secondsRemaining', () => {
  const now = new Date('2026-08-14T14:10:00.000Z');

  it('counts down to the end', () => {
    expect(secondsRemaining('2026-08-14T14:15:00.000Z', now)).toBe(300);
  });

  it('floors at zero rather than going negative', () => {
    // "-3:12 remaining" is not something a facilitator needs to see; the console shows an explicit
    // overrun state instead.
    expect(secondsRemaining('2026-08-14T14:05:00.000Z', now)).toBe(0);
  });

  it('is null for an untimed breakout', () => {
    expect(secondsRemaining(null, now)).toBeNull();
  });

  it('is null for an unparseable timestamp rather than NaN', () => {
    expect(secondsRemaining('not-a-date', now)).toBeNull();
  });
});

describe('isOverrunning', () => {
  const now = new Date('2026-08-14T14:10:00.000Z');

  it('is true once past the clock', () => {
    expect(isOverrunning('2026-08-14T14:05:00.000Z', now)).toBe(true);
  });

  it('is false before it', () => {
    expect(isOverrunning('2026-08-14T14:15:00.000Z', now)).toBe(false);
  });

  it('is false for an untimed breakout — it can never overrun', () => {
    expect(isOverrunning(null, now)).toBe(false);
  });

  it('is a DISPLAY state only — it does not end anything', () => {
    // The guard that keeps the clock advisory: a breakout past its time is still endable only by
    // an explicit call, and `canEndBreakout` neither knows nor cares about the clock.
    expect(canEndBreakout(state({ currentStepId: 'step_1' })).ok).toBe(true);
  });
});

describe('canParticipantAnswer', () => {
  it('is true only while a breakout is actually running', () => {
    expect(canParticipantAnswer(state({ currentStepId: 'step_1' }))).toBe(true);
  });

  it('is false between breakouts — the room is listening, not typing', () => {
    // An answer arriving between breakouts would land in whichever started next, corrupting a
    // synthesis that is scoped per period.
    expect(canParticipantAnswer(state({ currentStepId: null }))).toBe(false);
  });

  it('is false before the meeting starts and after it ends', () => {
    expect(canParticipantAnswer(state({ status: 'scheduled', currentStepId: 'step_1' }))).toBe(
      false
    );
    expect(canParticipantAnswer(state({ status: 'ended', currentStepId: 'step_1' }))).toBe(false);
  });
});
