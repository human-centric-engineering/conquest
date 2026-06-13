/**
 * Unit tests for the pure seriousness / abuse-gate escalation + strike logic.
 *
 * No Prisma / Next / LLM — count in, decision out. Covers the gate-active predicate and the
 * escalation: gentle → firm → abandon at the configured threshold.
 */

import { describe, expect, it } from 'vitest';

import {
  seriousnessGateActive,
  evaluateAbuseStrike,
  ABUSE_ABANDON_MESSAGE,
} from '@/lib/app/questionnaire/seriousness';

describe('seriousnessGateActive', () => {
  it('requires both the flag and a positive threshold', () => {
    expect(seriousnessGateActive(true, 4)).toBe(true);
    expect(seriousnessGateActive(false, 4)).toBe(false);
    expect(seriousnessGateActive(true, 0)).toBe(false);
    expect(seriousnessGateActive(false, 0)).toBe(false);
  });
});

describe('evaluateAbuseStrike', () => {
  it('increments the strike and warns (not abandon) below the threshold', () => {
    const out = evaluateAbuseStrike(0, 4);
    expect(out.newStrikeCount).toBe(1);
    expect(out.abandon).toBe(false);
    expect(out.noticeMessage.length).toBeGreaterThan(0);
    expect(out.abandonMessage).toBeUndefined();
  });

  it('firms up the warning on the last strike before the threshold', () => {
    const gentle = evaluateAbuseStrike(0, 4).noticeMessage; // strike 1, 3 remaining
    const firm = evaluateAbuseStrike(2, 4).noticeMessage; // strike 3, 1 remaining
    expect(firm).not.toBe(gentle);
    // The final warning names the consequence; the gentle one doesn't.
    expect(firm.toLowerCase()).toContain('end');
  });

  it('abandons on the threshold strike, carrying the final message', () => {
    const out = evaluateAbuseStrike(3, 4); // 4th strike == threshold
    expect(out.newStrikeCount).toBe(4);
    expect(out.abandon).toBe(true);
    expect(out.noticeMessage).toBe('');
    expect(out.abandonMessage).toBe(ABUSE_ABANDON_MESSAGE);
  });

  it('abandons immediately when the threshold is 1', () => {
    const out = evaluateAbuseStrike(0, 1);
    expect(out.newStrikeCount).toBe(1);
    expect(out.abandon).toBe(true);
  });

  it('matches the worked example (threshold 4): warn, warn, firm-warn, abandon', () => {
    expect(evaluateAbuseStrike(0, 4).abandon).toBe(false); // 1
    expect(evaluateAbuseStrike(1, 4).abandon).toBe(false); // 2
    expect(evaluateAbuseStrike(2, 4).abandon).toBe(false); // 3 (firm)
    expect(evaluateAbuseStrike(3, 4).abandon).toBe(true); // 4 → abandon
  });
});
