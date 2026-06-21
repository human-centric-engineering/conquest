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
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a phase closing after the round closes', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: null,
      closesAt: d('2026-08-01T00:00:00Z'),
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a phase whose close is not after its open', () => {
    const r = validatePhaseWindowNesting(round, {
      opensAt: d('2026-07-10T00:00:00Z'),
      closesAt: d('2026-07-10T00:00:00Z'),
    });
    expect(r).toMatchObject({ ok: false });
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
});
