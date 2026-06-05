import { describe, it, expect } from 'vitest';

import { SESSION_STATUSES, type SessionStatus } from '@/lib/app/questionnaire/types';
import {
  classifyTransition,
  canTransition,
  isTerminal,
  assertTransition,
  eventTypeFor,
} from '@/lib/app/questionnaire/session/session-logic';
import {
  SESSION_EVENT_TYPES,
  SessionTransitionError,
  type SessionEventType,
} from '@/lib/app/questionnaire/session/types';

/**
 * Exhaustive coverage of the F4.6 state machine. The DoP requires every per-turn
 * behaviour (here, every legal/illegal/idempotent edge) exercisable by hand, so this
 * walks the full 4×4 `(from → to)` matrix rather than spot-checking.
 *
 * The expected matrix — `a`=apply, `n`=noop (self-edge), `x`=illegal:
 *
 *            to: active  paused  completed  abandoned
 *   active        n       a        a          a
 *   paused        a       n        x          a
 *   completed     x       x        n          x
 *   abandoned     x       x        x          n
 */
const EXPECTED: Record<SessionStatus, Record<SessionStatus, 'apply' | 'noop' | 'illegal'>> = {
  active: { active: 'noop', paused: 'apply', completed: 'apply', abandoned: 'apply' },
  paused: { active: 'apply', paused: 'noop', completed: 'illegal', abandoned: 'apply' },
  completed: { active: 'illegal', paused: 'illegal', completed: 'noop', abandoned: 'illegal' },
  abandoned: { active: 'illegal', paused: 'illegal', completed: 'illegal', abandoned: 'noop' },
};

/** The event each `apply` edge records (only apply edges have one). */
const EXPECTED_EVENT: Partial<
  Record<SessionStatus, Partial<Record<SessionStatus, SessionEventType>>>
> = {
  active: { paused: 'paused', completed: 'completed', abandoned: 'abandoned' },
  paused: { active: 'resumed', abandoned: 'abandoned' },
};

describe('classifyTransition — full 4×4 matrix', () => {
  for (const from of SESSION_STATUSES) {
    for (const to of SESSION_STATUSES) {
      it(`${from} → ${to} is ${EXPECTED[from][to]}`, () => {
        expect(classifyTransition(from, to)).toBe(EXPECTED[from][to]);
      });
    }
  }

  it('covers every status pair (no gap in the matrix)', () => {
    // Guards against SESSION_STATUSES growing without this test being updated.
    expect(SESSION_STATUSES).toEqual(['active', 'paused', 'completed', 'abandoned']);
  });
});

describe('canTransition', () => {
  it('is true exactly for apply edges and false otherwise', () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        expect(canTransition(from, to)).toBe(EXPECTED[from][to] === 'apply');
      }
    }
  });
});

describe('isTerminal', () => {
  it('completed and abandoned are terminal; active and paused are not', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('abandoned')).toBe(true);
    expect(isTerminal('active')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
  });

  it('a terminal status has no apply edge to any other status', () => {
    for (const from of ['completed', 'abandoned'] as const) {
      for (const to of SESSION_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('assertTransition', () => {
  it('throws SessionTransitionError on every illegal edge, carrying from/to', () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (EXPECTED[from][to] !== 'illegal') continue;
        let caught: unknown;
        try {
          assertTransition(from, to);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SessionTransitionError);
        const error = caught as SessionTransitionError;
        expect(error.from).toBe(from);
        expect(error.to).toBe(to);
        expect(error.message).toContain(`${from} → ${to}`);
      }
    }
  });

  it('does not throw on apply or noop edges', () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (EXPECTED[from][to] === 'illegal') continue;
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('the canonical illegal edge paused → completed throws (must resume first)', () => {
    expect(() => assertTransition('paused', 'completed')).toThrow(SessionTransitionError);
  });
});

describe('eventTypeFor', () => {
  it('maps every apply edge to its event type (resume → resumed; else target status)', () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (EXPECTED[from][to] !== 'apply') continue;
        expect(eventTypeFor(from, to)).toBe(EXPECTED_EVENT[from]?.[to]);
      }
    }
  });

  it('paused → active is resumed, not active', () => {
    expect(eventTypeFor('paused', 'active')).toBe('resumed');
  });

  it('every produced event type is a member of SESSION_EVENT_TYPES', () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (EXPECTED[from][to] !== 'apply') continue;
        expect(SESSION_EVENT_TYPES).toContain(eventTypeFor(from, to));
      }
    }
  });
});

describe('SESSION_EVENT_TYPES vocabulary', () => {
  it('carries the transition events plus created and cost_cap_reached', () => {
    expect(SESSION_EVENT_TYPES).toEqual([
      'created',
      'paused',
      'resumed',
      'completed',
      'abandoned',
      'cost_cap_reached',
    ]);
  });
});
