/**
 * buildScheduleView / formatDateRange — pure derivation of the chat-banner schedule cluster
 * (status pill + date window) from a round and an injected clock.
 *
 * @see lib/app/questionnaire/header/schedule.ts
 */

import { describe, it, expect } from 'vitest';

import { buildScheduleView, formatDateRange } from '@/lib/app/questionnaire/header/schedule';
import type { BandRound } from '@/lib/app/questionnaire/header/types';

const NOW = new Date('2026-06-15T12:00:00Z');

/** A round with sensible defaults; override per case. */
function round(over: Partial<BandRound> = {}): BandRound {
  return {
    name: 'Round 3 · Spring Cohort',
    status: 'open',
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ...over,
  };
}

describe('formatDateRange', () => {
  it('renders a same-year window with the year shown once, at the end', () => {
    expect(
      formatDateRange(new Date('2026-04-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'))
    ).toBe('1 Apr – 30 Jun 2026');
  });

  it('shows the start year too when the window spans new year', () => {
    expect(
      formatDateRange(new Date('2025-12-15T00:00:00Z'), new Date('2026-01-10T00:00:00Z'))
    ).toBe('15 Dec 2025 – 10 Jan 2026');
  });

  it('renders a single-bound window with Until / From', () => {
    expect(formatDateRange(null, new Date('2026-06-30T00:00:00Z'))).toBe('Until 30 Jun 2026');
    expect(formatDateRange(new Date('2026-04-01T00:00:00Z'), null)).toBe('From 1 Apr 2026');
  });

  it('is empty when neither bound is set', () => {
    expect(formatDateRange(null, null)).toBe('');
  });
});

describe('buildScheduleView', () => {
  it('returns null when the round has no dates (open-ended — no schedule cluster)', () => {
    expect(buildScheduleView(round(), NOW)).toBeNull();
  });

  it('is Open with a countdown when inside the window and the close is near-ish', () => {
    const view = buildScheduleView(
      round({
        opensAt: new Date('2026-04-01T00:00:00Z'),
        closesAt: new Date('2026-06-27T12:00:00Z'),
      }),
      NOW
    );
    expect(view).toEqual({
      status: 'open',
      statusLabel: 'Open · closes in 12 days',
      dateRange: '1 Apr – 27 Jun 2026',
    });
  });

  it('drops the countdown (plain Open) when the close is far off', () => {
    const view = buildScheduleView(
      round({
        opensAt: new Date('2026-04-01T00:00:00Z'),
        closesAt: new Date('2026-12-31T00:00:00Z'),
      }),
      NOW
    );
    expect(view?.status).toBe('open');
    expect(view?.statusLabel).toBe('Open');
  });

  it('flips to closing-soon within the threshold', () => {
    const view = buildScheduleView(round({ closesAt: new Date('2026-06-17T12:00:00Z') }), NOW);
    expect(view?.status).toBe('closing-soon');
    expect(view?.statusLabel).toBe('Closing soon · 2 days');
  });

  it('says "Closes tomorrow" / "Closes today" at the very end', () => {
    expect(
      buildScheduleView(round({ closesAt: new Date('2026-06-16T12:00:00Z') }), NOW)?.statusLabel
    ).toBe('Closes tomorrow');
    expect(
      buildScheduleView(round({ closesAt: new Date('2026-06-15T18:00:00Z') }), NOW)?.statusLabel
    ).toBe('Closes today');
  });

  it('is Upcoming before the window opens', () => {
    const view = buildScheduleView(
      round({
        opensAt: new Date('2026-07-01T00:00:00Z'),
        closesAt: new Date('2026-08-31T00:00:00Z'),
      }),
      NOW
    );
    expect(view).toEqual({
      status: 'upcoming',
      statusLabel: 'Opens 1 Jul',
      dateRange: '1 Jul – 31 Aug 2026',
    });
  });

  it('is Closed once the window has passed', () => {
    const view = buildScheduleView(
      round({
        opensAt: new Date('2026-01-01T00:00:00Z'),
        closesAt: new Date('2026-03-31T00:00:00Z'),
      }),
      NOW
    );
    expect(view?.status).toBe('closed');
    expect(view?.statusLabel).toBe('Closed');
    expect(view?.dateRange).toBe('1 Jan – 31 Mar 2026');
  });

  it('is Closed when the round status is closed, even inside the date window', () => {
    const view = buildScheduleView(
      round({
        status: 'closed',
        opensAt: new Date('2026-04-01T00:00:00Z'),
        closesAt: new Date('2026-08-01T00:00:00Z'),
      }),
      NOW
    );
    expect(view?.status).toBe('closed');
  });

  it('is Closed when manually closed (closedAt set) before the window end', () => {
    const view = buildScheduleView(
      round({
        opensAt: new Date('2026-04-01T00:00:00Z'),
        closesAt: new Date('2026-08-01T00:00:00Z'),
        closedAt: new Date('2026-06-10T00:00:00Z'),
      }),
      NOW
    );
    expect(view?.status).toBe('closed');
  });

  it('is Open with no countdown when only an (already past) opensAt is set', () => {
    const view = buildScheduleView(round({ opensAt: new Date('2026-04-01T00:00:00Z') }), NOW);
    expect(view).toEqual({ status: 'open', statusLabel: 'Open', dateRange: 'From 1 Apr 2026' });
  });
});
