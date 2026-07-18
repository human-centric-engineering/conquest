/**
 * Unit test: compact date/time formatting for dense admin tables.
 *
 * Pins the year-elision rule (current year drops the year, other years keep it), the seconds-free
 * 24-hour time, the full-string passthrough for tooltips, and the invalid-input fallback. `now` is
 * injected so the year-boundary behaviour is deterministic rather than depending on the clock.
 */

import { describe, it, expect } from 'vitest';

import { formatCompactDateTime } from '@/lib/utils/format-datetime';

const NOW = new Date('2026-07-18T12:00:00.000Z');

describe('formatCompactDateTime', () => {
  it('omits the year for a timestamp in the current year', () => {
    const { date } = formatCompactDateTime('2026-07-06T18:01:03.000Z', NOW);
    expect(date).not.toMatch(/2026/);
    // Locale-dependent order, but the day and short month are always present.
    expect(date).toMatch(/6/);
    expect(date).toMatch(/Jul/i);
  });

  it('keeps the year for a timestamp in a different year', () => {
    const { date } = formatCompactDateTime('2025-07-06T18:01:03.000Z', NOW);
    expect(date).toMatch(/2025/);
  });

  it('formats the time as 24-hour without seconds', () => {
    const { time } = formatCompactDateTime('2026-07-06T18:01:03.000Z', NOW);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(time).not.toMatch(/03/); // seconds dropped
  });

  it('carries the full locale string for a tooltip', () => {
    const { full } = formatCompactDateTime('2026-07-06T18:01:03.000Z', NOW);
    expect(full).not.toBe('');
    expect(full).toBe(new Date('2026-07-06T18:01:03.000Z').toLocaleString());
  });

  it('falls back to a dash for an unparseable timestamp', () => {
    expect(formatCompactDateTime('not-a-date', NOW)).toEqual({ date: '—', time: '', full: '' });
  });
});
