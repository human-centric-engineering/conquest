import { describe, it, expect } from 'vitest';

import { narrowToEnum, SESSION_STATUSES, ANSWER_PROVENANCES } from '@/lib/app/questionnaire/types';

/**
 * The shared boundary guard for reading plain `String` columns we validate at the app
 * layer (`status`, `provenanceLabel`, …). It replaced the per-seam `asSessionStatus` /
 * `asProvenance` narrowers, so its defaulting behaviour is the single thing those read
 * paths now rely on.
 */
describe('narrowToEnum', () => {
  it('returns the value unchanged when it is a member of the tuple', () => {
    expect(narrowToEnum('paused', SESSION_STATUSES, 'active')).toBe('paused');
    expect(narrowToEnum('refined', ANSWER_PROVENANCES, 'direct')).toBe('refined');
  });

  it('falls back when the value is not a member (stray DB value)', () => {
    expect(narrowToEnum('bogus', SESSION_STATUSES, 'active')).toBe('active');
    expect(narrowToEnum('', ANSWER_PROVENANCES, 'direct')).toBe('direct');
  });

  it('is case-sensitive — a near-miss is not a member', () => {
    expect(narrowToEnum('Active', SESSION_STATUSES, 'active')).toBe('active');
  });
});
