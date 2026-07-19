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
  abuseAbortMessage,
} from '@/lib/app/questionnaire/seriousness';

describe('seriousnessGateActive', () => {
  it('is active only for a positive threshold — 0 means off for this questionnaire', () => {
    expect(seriousnessGateActive(4)).toBe(true);
    expect(seriousnessGateActive(1)).toBe(true);
    expect(seriousnessGateActive(0)).toBe(false);
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
    const gentle = evaluateAbuseStrike(0, 4); // strike 1, 3 remaining
    const firm = evaluateAbuseStrike(2, 4); // strike 3, 1 remaining
    expect(firm.noticeMessage).not.toBe(gentle.noticeMessage);
    // The final warning is flagged `final` (→ red notice) and names the consequence — one more
    // infringement aborts the conversation — in a bold (**…**) sentence.
    expect(gentle.final).toBe(false);
    expect(firm.final).toBe(true);
    expect(firm.noticeMessage.toLowerCase()).toContain('final warning');
    expect(firm.noticeMessage.toLowerCase()).toContain('aborted');
    expect(firm.noticeMessage).toContain('**');
  });

  it('aborts on the threshold strike, carrying the counted final message', () => {
    const out = evaluateAbuseStrike(3, 4); // 4th strike == threshold
    expect(out.newStrikeCount).toBe(4);
    expect(out.abandon).toBe(true);
    expect(out.noticeMessage).toBe('');
    // The abort message names the count and records the session as aborted.
    expect(out.abandonMessage).toBe(abuseAbortMessage(4));
    expect(out.abandonMessage).toContain('4 occasions');
    expect(out.abandonMessage).toContain('aborted');
  });

  it('aborts immediately when the threshold is 1, with a singular-aware message', () => {
    const out = evaluateAbuseStrike(0, 1);
    expect(out.newStrikeCount).toBe(1);
    expect(out.abandon).toBe(true);
    expect(out.abandonMessage).toBe(abuseAbortMessage(1));
    expect(out.abandonMessage).toContain('1 occasion ');
    expect(out.abandonMessage).not.toContain('occasions');
  });

  it('matches the worked example (threshold 4): warn, warn, firm-warn, abandon', () => {
    expect(evaluateAbuseStrike(0, 4).abandon).toBe(false); // 1
    expect(evaluateAbuseStrike(1, 4).abandon).toBe(false); // 2
    expect(evaluateAbuseStrike(2, 4).abandon).toBe(false); // 3 (firm)
    expect(evaluateAbuseStrike(3, 4).abandon).toBe(true); // 4 → abandon
  });
});
