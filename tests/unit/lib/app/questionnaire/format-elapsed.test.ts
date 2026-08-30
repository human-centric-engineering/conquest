/**
 * Unit tests: shared `mm:ss` formatting for a running wait (F20.2).
 *
 * Small, but it is now on three surfaces — the admin upload ticker, the extraction progress line,
 * and the respondent turn indicator — and it was lifted out of one of them precisely so they could
 * not drift. The interesting cases are the ones a live counter actually produces: the minute
 * rollover, and the defensive inputs a timer can hand it if a clock jumps.
 */

import { describe, it, expect } from 'vitest';

import { formatElapsed } from '@/lib/app/questionnaire/format-elapsed';

describe('formatElapsed', () => {
  it('zero-pads both fields so the counter never changes width', () => {
    // A counter that jumps from "0:9" to "0:10" to "1:00" shifts the layout beside it every time.
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(5)).toBe('00:05');
    expect(formatElapsed(9)).toBe('00:09');
  });

  it('rolls seconds into minutes rather than counting past 59', () => {
    expect(formatElapsed(59)).toBe('00:59');
    expect(formatElapsed(60)).toBe('01:00');
    expect(formatElapsed(61)).toBe('01:01');
    expect(formatElapsed(75)).toBe('01:15');
  });

  it('keeps counting past ten minutes without widening unexpectedly', () => {
    expect(formatElapsed(599)).toBe('09:59');
    expect(formatElapsed(600)).toBe('10:00');
    expect(formatElapsed(3599)).toBe('59:59');
    // Past an hour it keeps accumulating minutes rather than silently wrapping to 00:00, which
    // would tell a viewer the wait had restarted.
    expect(formatElapsed(3600)).toBe('60:00');
  });

  it('clamps a negative to zero instead of rendering a minus sign', () => {
    // Reachable if a system clock steps backwards mid-wait.
    expect(formatElapsed(-1)).toBe('00:00');
    expect(formatElapsed(-120)).toBe('00:00');
  });

  it('floors a fractional second rather than printing a decimal', () => {
    expect(formatElapsed(4.9)).toBe('00:04');
    expect(formatElapsed(59.999)).toBe('00:59');
  });

  it('renders a non-finite input as zero rather than NaN:NaN', () => {
    expect(formatElapsed(Number.NaN)).toBe('00:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('00:00');
  });
});
