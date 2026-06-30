/**
 * Schedule view for the respondent chat banner — pure derivation (no Prisma / React).
 *
 * Turns a {@link BandRound} (round name + open/close window) plus the current instant into a
 * small, ready-to-render {@link ScheduleView}: a status (drives the dot colour), a short status
 * label ("Open · closes in 12 days", "Closing soon", "Opens 1 Jul", "Closed") and a formatted
 * date range ("1 Apr – 30 Jun 2026"). Returns null when there is nothing time-bound to show, so
 * the band can simply omit the schedule cluster.
 *
 * `now` is injected (never `new Date()` inside) so the derivation is deterministic and unit-
 * testable; the band passes the render-time clock. The labels are SSR-computed and therefore as
 * fresh as the page load — fine for a day-granularity window.
 */

import type { BandRound } from '@/lib/app/questionnaire/header/types';

/** Within this many days of `closesAt`, an open round flips to the amber "closing soon" state. */
const CLOSING_SOON_DAYS = 3;
/** Beyond this many days out, an open round drops the "closes in N days" tail (just "Open"). */
const COUNTDOWN_WITHIN_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** Drives the band's status-dot colour and copy. */
export type ScheduleStatus = 'upcoming' | 'open' | 'closing-soon' | 'closed';

/** A render-ready schedule cluster: status + its label + the formatted date window. */
export interface ScheduleView {
  status: ScheduleStatus;
  /** Short, uppercase-styled status copy (the band capitalises via CSS). */
  statusLabel: string;
  /** Human date window, e.g. "1 Apr – 30 Jun 2026"; '' when no dates are set. */
  dateRange: string;
}

/** Whole days remaining from `now` until `when` (floor: 0 = closes later today, 1 = tomorrow). */
function daysUntil(when: Date, now: Date): number {
  return Math.floor((when.getTime() - now.getTime()) / MS_PER_DAY);
}

function formatDay(date: Date, withYear: boolean): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(date);
}

/**
 * Format the window for display. Both dates → "1 Apr – 30 Jun 2026" (the start year is shown only
 * when it differs from the end year); a single bound → "Until …" / "From …".
 */
export function formatDateRange(opensAt: Date | null, closesAt: Date | null): string {
  if (opensAt && closesAt) {
    const sameYear = opensAt.getFullYear() === closesAt.getFullYear();
    return `${formatDay(opensAt, !sameYear)} – ${formatDay(closesAt, true)}`;
  }
  if (closesAt) return `Until ${formatDay(closesAt, true)}`;
  if (opensAt) return `From ${formatDay(opensAt, true)}`;
  return '';
}

/**
 * Derive the schedule cluster for a round. Returns null when there is nothing time-bound to show
 * (no round dates at all) — the round name still renders as the title eyebrow, but the right-hand
 * schedule cluster is omitted.
 */
export function buildScheduleView(round: BandRound, now: Date): ScheduleView | null {
  const { opensAt, closesAt } = round;
  if (!opensAt && !closesAt) return null;

  const dateRange = formatDateRange(opensAt, closesAt);

  // Closed: an explicit close (status / closedAt) or the window's end has passed.
  if (
    round.status === 'closed' ||
    round.closedAt ||
    (closesAt && now.getTime() > closesAt.getTime())
  ) {
    return { status: 'closed', statusLabel: 'Closed', dateRange };
  }

  // Upcoming: the window hasn't opened yet.
  if (opensAt && now.getTime() < opensAt.getTime()) {
    return { status: 'upcoming', statusLabel: `Opens ${formatDay(opensAt, false)}`, dateRange };
  }

  // Open. With a close date we surface urgency: "closing soon" near the end, otherwise a
  // countdown for nearby closes and a plain "Open" when the end is far off (or unbounded).
  if (closesAt) {
    const left = daysUntil(closesAt, now);
    if (left <= CLOSING_SOON_DAYS) {
      const label =
        left <= 0 ? 'Closes today' : left === 1 ? 'Closes tomorrow' : `Closing soon · ${left} days`;
      return { status: 'closing-soon', statusLabel: label, dateRange };
    }
    const label = left <= COUNTDOWN_WITHIN_DAYS ? `Open · closes in ${left} days` : 'Open';
    return { status: 'open', statusLabel: label, dateRange };
  }

  return { status: 'open', statusLabel: 'Open', dateRange };
}
