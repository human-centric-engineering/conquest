/**
 * Breakout rooms (P15.5b).
 *
 * Rooms are the optional refinement on a breakout: the group splits, each room takes its own
 * questionnaire, and works either individually or through one person writing for everybody.
 */

import { describe, it, expect } from 'vitest';

import {
  BREAKOUT_ROOM_MODES,
  BREAKOUT_ROOM_MODE_LABELS,
  canChooseRoom,
} from '@/lib/app/questionnaire/experiences/meeting/types';

describe('room modes', () => {
  it('offers exactly two, and labels both in a facilitator’s words', () => {
    expect([...BREAKOUT_ROOM_MODES]).toEqual(['individual', 'scribe']);
    expect(BREAKOUT_ROOM_MODE_LABELS.individual).toBe('Everyone answers their own');
    expect(BREAKOUT_ROOM_MODE_LABELS.scribe).toBe('One person writes for the room');
  });
});

describe('canChooseRoom', () => {
  const base = { breakoutRunning: true, phase: 'running' as const, hasRooms: true };

  it('is true while a breakout with rooms is running', () => {
    expect(canChooseRoom(base)).toBe(true);
  });

  it('is false when the breakout has no rooms — the common case', () => {
    expect(canChooseRoom({ ...base, hasRooms: false })).toBe(false);
  });

  it('is false between breakouts', () => {
    expect(canChooseRoom({ ...base, breakoutRunning: false })).toBe(false);
  });

  it('is FALSE during grace, not just when closed', () => {
    // The judgement worth pinning: arriving at a room with seconds left, to a questionnaire you
    // have not started, is worse than being told you missed it. Grace is for finishing, not
    // starting.
    expect(canChooseRoom({ ...base, phase: 'grace' })).toBe(false);
  });

  it('is false once closed', () => {
    expect(canChooseRoom({ ...base, phase: 'closed' })).toBe(false);
  });
});
