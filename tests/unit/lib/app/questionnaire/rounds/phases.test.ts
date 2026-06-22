/**
 * Unit: round-phase pure window logic — nesting validation + effective-window resolution.
 */

import { describe, it, expect } from 'vitest';

import {
  resolveEffectiveWindow,
  validatePhaseWindowNesting,
} from '@/lib/app/questionnaire/rounds/phases';

const d = (s: string) => new Date(s);

describe('validatePhaseWindowNesting', () => {
  const round = { opensAt: d('2026-07-01T00:00:00Z'), closesAt: d('2026-07-31T00:00:00Z') };

  it('accepts a window fully inside the round window', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: d('2026-07-05T00:00:00Z'),
      closesAt: d('2026-07-10T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
  });

  it('accepts null phase bounds (they inherit the round bounds)', () => {
    expect(validatePhaseWindowNesting(round, { opensAt: null, closesAt: null }).ok).toBe(true);
  });

  it('rejects a phase opening before the round opens', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: d('2026-06-30T00:00:00Z'),
      closesAt: null,
    });
    // The message is public contract — it surfaces verbatim in the route's 422 error response.
    expect(r).toEqual({ ok: false, message: 'A phase cannot open before the round opens.' });
  });

  it('rejects a phase closing after the round closes', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: null,
      closesAt: d('2026-08-01T00:00:00Z'),
    });
    expect(r).toEqual({ ok: false, message: 'A phase cannot close after the round closes.' });
  });

  it('rejects a phase whose close is not after its open', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: d('2026-07-10T00:00:00Z'),
      closesAt: d('2026-07-10T00:00:00Z'),
    });
    expect(r).toEqual({ ok: false, message: 'The phase close date must be after its open date.' });
  });

  it('rejects a phase that opens after the round closes (impossible window)', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: d('2026-08-05T00:00:00Z'), // after round close, no phase close of its own
      closesAt: null,
    });
    expect(r).toEqual({ ok: false, message: 'A phase cannot open after the round closes.' });
  });

  it('treats an unbounded round side as always satisfied', () => {
    const openRound = { opensAt: null, closesAt: null };
    expect(
      validatePhaseWindowNesting(openRound, {
        opensAt: d('2026-01-01T00:00:00Z'),
        closesAt: d('2026-12-31T00:00:00Z'),
      }).ok
    ).toBe(true);
  });
});

describe('resolveEffectiveWindow', () => {
  const round = { opensAt: d('2026-07-01T00:00:00Z'), closesAt: d('2026-07-31T00:00:00Z') };

  it('returns the round window unchanged when there is no phase', () => {
    expect(resolveEffectiveWindow(round, null)).toEqual(round);
  });

  it('uses the phase open and (for a hard end) the phase close', () => {
    const w = resolveEffectiveWindow(round, {
      opensAt: d('2026-07-01T00:00:00Z'),
      closesAt: d('2026-07-07T00:00:00Z'),
      endMode: 'hard',
    });
    expect(w.opensAt).toEqual(d('2026-07-01T00:00:00Z'));
    expect(w.closesAt).toEqual(d('2026-07-07T00:00:00Z'));
  });

  it('relaxes the close to the round close, keeping the staggered open', () => {
    const w = resolveEffectiveWindow(round, {
      opensAt: d('2026-07-08T00:00:00Z'),
      closesAt: d('2026-07-14T00:00:00Z'), // a target only under relaxed
      endMode: 'relaxed',
    });
    expect(w.opensAt).toEqual(d('2026-07-08T00:00:00Z'));
    expect(w.closesAt).toEqual(round.closesAt);
  });

  it('inherits a null phase bound from the round on that side', () => {
    const w = resolveEffectiveWindow(round, { opensAt: null, closesAt: null, endMode: 'hard' });
    expect(w).toEqual(round);
  });

  it('clamps a hard phase close to the round close when the round window shrank below it', () => {
    // Phase was created when the round closed later; the round was since narrowed to 07-31.
    const w = resolveEffectiveWindow(round, {
      opensAt: d('2026-07-02T00:00:00Z'),
      closesAt: d('2026-08-15T00:00:00Z'), // now beyond the round close
      endMode: 'hard',
    });
    expect(w.closesAt).toEqual(round.closesAt); // clamped — round stays the outer cap
  });

  it('clamps a phase open up to the round open when the phase would open earlier', () => {
    const w = resolveEffectiveWindow(round, {
      opensAt: d('2026-06-20T00:00:00Z'), // before the round opens
      closesAt: null,
      endMode: 'hard',
    });
    expect(w.opensAt).toEqual(round.opensAt); // clamped up to the round open
  });
});
