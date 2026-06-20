/**
 * Unit: the pure round access guard (`evaluateRoundAccess`).
 *
 * The single source of the time-bound + membership rules. Tested as a matrix — round status ×
 * window × member status × questionnaire-in-round — because every respondent start/continue
 * delegates here. No DB, no clock: the instant is injected.
 */

import { describe, it, expect } from 'vitest';

import { evaluateRoundAccess } from '@/lib/app/questionnaire/rounds/access';
import type { RoundAccessSubject } from '@/lib/app/questionnaire/rounds/access';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const EARLIER = new Date('2026-06-01T00:00:00.000Z');
const LATER = new Date('2026-07-01T00:00:00.000Z');

function subject(over: Partial<RoundAccessSubject> = {}): RoundAccessSubject {
  return {
    round: { status: 'open', opensAt: EARLIER, closesAt: LATER },
    member: { status: 'active' },
    questionnaireInRound: true,
    now: NOW,
    ...over,
  };
}

describe('evaluateRoundAccess', () => {
  it('allows an open round, inside window, active member, questionnaire bundled', () => {
    expect(evaluateRoundAccess(subject())).toEqual({ ok: true });
  });

  it('allows when there is no member (round window still applies, member check skipped)', () => {
    expect(evaluateRoundAccess(subject({ member: null }))).toEqual({ ok: true });
  });

  it('allows an open round with no window bounds', () => {
    expect(
      evaluateRoundAccess(subject({ round: { status: 'open', opensAt: null, closesAt: null } }))
    ).toEqual({ ok: true });
  });

  it('denies QUESTIONNAIRE_NOT_IN_ROUND first, before any other check', () => {
    const v = evaluateRoundAccess(
      subject({
        questionnaireInRound: false,
        round: { status: 'closed', opensAt: EARLIER, closesAt: LATER }, // also closed
        member: { status: 'removed' }, // also removed
      })
    );
    expect(v).toMatchObject({ ok: false, code: 'QUESTIONNAIRE_NOT_IN_ROUND', status: 409 });
  });

  it('denies a draft round as ROUND_NOT_OPEN', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'draft', opensAt: null, closesAt: null } })
    );
    expect(v).toMatchObject({ ok: false, code: 'ROUND_NOT_OPEN', status: 409 });
  });

  it('denies a closed round as ROUND_NOT_OPEN', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'closed', opensAt: EARLIER, closesAt: LATER } })
    );
    expect(v).toMatchObject({ ok: false, code: 'ROUND_NOT_OPEN' });
  });

  it('denies before the window opens (ROUND_NOT_OPEN)', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'open', opensAt: LATER, closesAt: null } })
    );
    expect(v).toMatchObject({ ok: false, code: 'ROUND_NOT_OPEN', status: 409 });
  });

  it('denies after the window closes even when status is still open (ROUND_WINDOW_CLOSED)', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'open', opensAt: EARLIER, closesAt: EARLIER } })
    );
    expect(v).toMatchObject({ ok: false, code: 'ROUND_WINDOW_CLOSED', status: 409 });
  });

  it('denies a removed member as COHORT_MEMBER_REMOVED (403), after window passes', () => {
    const v = evaluateRoundAccess(subject({ member: { status: 'removed' } }));
    expect(v).toMatchObject({ ok: false, code: 'COHORT_MEMBER_REMOVED', status: 403 });
  });

  it('treats opensAt exactly equal to now as open (inclusive lower bound)', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'open', opensAt: NOW, closesAt: LATER } })
    );
    expect(v).toEqual({ ok: true });
  });

  it('treats closesAt exactly equal to now as still open (inclusive upper bound)', () => {
    const v = evaluateRoundAccess(
      subject({ round: { status: 'open', opensAt: EARLIER, closesAt: NOW } })
    );
    expect(v).toEqual({ ok: true });
  });
});
