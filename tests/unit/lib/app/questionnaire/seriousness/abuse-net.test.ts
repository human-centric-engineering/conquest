/**
 * keywordAbuseFloor — unit tests.
 *
 * Pure, deterministic floor: a string in, `{ reason }` or undefined out. No mocks. This is the
 * non-LLM guarantee that short, clearly-abusive dismissals are struck regardless of what the
 * probabilistic judge would say.
 *
 * @see lib/app/questionnaire/seriousness/abuse-net.ts
 */

import { describe, it, expect } from 'vitest';

import { keywordAbuseFloor, ABUSE_NET_REASON } from '@/lib/app/questionnaire/seriousness/abuse-net';

describe('keywordAbuseFloor — flags short directed hostility', () => {
  it.each([
    'go fuck yourself',
    'oh just fuck off',
    'fuck you',
    'screw you',
    'piss off',
    'shut up',
    'stfu',
    'go to hell',
    'up yours',
    'sod off',
  ])('flags %j as abuse', (message) => {
    const out = keywordAbuseFloor(message);
    expect(out).toEqual({ reason: ABUSE_NET_REASON });
  });

  it('is case-insensitive', () => {
    expect(keywordAbuseFloor('FUCK OFF')).toBeDefined();
  });
});

describe('keywordAbuseFloor — leaves nuanced cases to the judge', () => {
  it('does NOT flag a longer sentence that merely REPORTS a hostile phrase', () => {
    // "my manager told me to fuck off" is a genuine report, not a dismissal at the interviewer.
    expect(keywordAbuseFloor('my manager told me to fuck off')).toBeUndefined();
  });

  it.each([
    // Genuine answers / complaints — no directed-dismissal phrase.
    'my boss is an asshole', // a bare insult inside a genuine complaint, not a dismissal
    'this is fucking frustrating',
    'I would not recommend it at all',
    'the printer never works',
    '543 years', // preposterous — the judge's job, not the floor's
    '',
  ])('does NOT flag %j', (message) => {
    expect(keywordAbuseFloor(message)).toBeUndefined();
  });
});
