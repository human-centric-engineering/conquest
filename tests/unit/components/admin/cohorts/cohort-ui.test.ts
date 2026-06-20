/**
 * Unit: the pure `humanizeWindow` helper behind the round status/window presentation.
 *
 * `now` is injected so the relative phrasing is deterministic.
 */

import { describe, it, expect } from 'vitest';

import { humanizeWindow } from '@/components/admin/cohorts/cohort-ui';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const iso = (s: string) => new Date(s).toISOString();

describe('humanizeWindow', () => {
  it('always reads "Closed" for a closed round, regardless of dates', () => {
    expect(humanizeWindow('closed', iso('2026-06-01'), iso('2026-12-01'), NOW)).toBe('Closed');
  });

  it('reads "Opens …" while the window is still in the future', () => {
    expect(humanizeWindow('open', iso('2026-06-23'), iso('2026-07-01'), NOW)).toBe(
      'Opens in 3 days'
    );
    expect(humanizeWindow('open', iso('2026-06-21'), null, NOW)).toBe('Opens tomorrow');
  });

  it('reads "Closes …" once open and inside the window', () => {
    expect(humanizeWindow('open', iso('2026-06-01'), iso('2026-06-25'), NOW)).toBe(
      'Closes in 5 days'
    );
  });

  it('reads "Window ended …" when the close date has passed', () => {
    expect(humanizeWindow('open', iso('2026-06-01'), iso('2026-06-19'), NOW)).toBe(
      'Window ended yesterday'
    );
  });

  it('reads "No end date" for an open round with no close bound', () => {
    expect(humanizeWindow('open', iso('2026-06-01'), null, NOW)).toBe('No end date');
  });

  it('reads "Not scheduled" for a draft round with no dates', () => {
    expect(humanizeWindow('draft', null, null, NOW)).toBe('Not scheduled');
  });
});
