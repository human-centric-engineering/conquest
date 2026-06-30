/**
 * Respondent chat-banner header model (F7.1+ band content).
 *
 * The brand band at the top of the conversation carries, alongside the client logo, the
 * questionnaire title and — when the session runs inside a time-bound round — that round's
 * name and open/close window. These are the resolved values the band renders; the schedule
 * *view* (status pill + formatted date range) is derived from {@link BandRound} by the pure
 * helpers in `./schedule`.
 *
 * Pure contract — no Prisma / React. The DB seam (`./resolve`) populates it; the band
 * (`components/app/questionnaire/chat/brand-theme-provider.tsx`) and its tests consume it.
 */

/** A time-bound round's identity + window, as the band needs it. */
export interface BandRound {
  /** Round display name (e.g. "Round 3 · Spring Cohort"); shown as the title eyebrow. */
  name: string;
  /** ROUND_STATUSES: draft | open | closed. A `closed` round reads Closed regardless of dates. */
  status: string;
  /** Window start, or null for no lower bound. */
  opensAt: Date | null;
  /** Window end, or null for no upper bound (open-ended close). */
  closesAt: Date | null;
  /** Manual/auto close timestamp; when set the round is Closed even before `closesAt`. */
  closedAt: Date | null;
}

/** The fully-resolved banner header for a respondent surface. */
export interface BandHeader {
  /** The questionnaire title — the band's lead text. */
  title: string;
  /** The round context, or null for an open-ended session (no time-bound window). */
  round: BandRound | null;
}
