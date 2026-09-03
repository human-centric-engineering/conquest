/**
 * Sectioned interviews (P21) — the per-session run state.
 *
 * `AppQuestionnaireSession.sectionRun` records which section the respondent is in and what has
 * happened to each one. Read through {@link narrowSectionRun}, never destructured raw, exactly as
 * `interviewPlan` is.
 *
 * ## Why the transitions live here rather than in a seam
 *
 * The session lifecycle needed a `LEGAL_TRANSITIONS` matrix and a guarded writer because it crosses
 * genuinely terminal states: a `completed` session must not silently reopen. A section has no
 * terminal state. `closed` is a position in a run, and reopening one is an ordinary move the
 * respondent is entitled to make. So the functions below are plain pure state transforms, and the
 * route's job is authorisation and persistence rather than adjudication.
 *
 * Pure: no Prisma, no Next.
 */

import { isRecord } from '@/lib/utils';
import {
  SECTION_CLOSE_REASONS,
  SECTION_STATUSES,
  narrowSectionEnum,
  type InterviewSection,
  type SectionCloseReason,
  type SectionStatus,
} from '@/lib/app/questionnaire/sections/types';

/** How long a section key may be. Generous: a document section's key is a cuid, a theme's a slug. */
const SECTION_KEY_MAX_LENGTH = 512;

/** Most sections one run may track. Far past any real instrument; a bound on a stored blob. */
export const MAX_TRACKED_SECTIONS = 200;

/** One section's state within a run. */
export interface SectionRunEntry {
  key: string;
  status: SectionStatus;
  /** Turn ordinal this section was first opened at. `0` before the first turn lands. */
  openedAtTurn: number;
  /** Turn ordinal it was closed at, or null while it is open. */
  closedAtTurn: number | null;
  closeReason: SectionCloseReason | null;
  /** How many times it was reopened after closing. Feeds the admin timeline, nothing analytic. */
  reopenCount: number;
  /**
   * Turns spent in this section, across every visit to it.
   *
   * Counted rather than derived from `openedAtTurn` and the current ordinal, because under free
   * navigation those turns are not contiguous: a respondent who works in section 1, jumps to
   * section 3 and comes back would have every turn spent in section 3 charged to section 1's
   * budget. This is what `maxTurnsPerSection` is measured against.
   */
  turnsSpent: number;
}

/** The blob on the session row. */
export interface SectionRun {
  v: 1;
  /**
   * The section the conversation is currently in, or null before the first one opens.
   *
   * Nullable rather than defaulting to the first section because "the run has not started" and "the
   * run is in its first section" are different states, and the difference decides whether the next
   * turn is an opening.
   */
  activeKey: string | null;
  sections: SectionRunEntry[];
}

/* -------------------------------------------------------------------------- */
/* Narrower                                                                   */
/* -------------------------------------------------------------------------- */

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asOrdinal(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

/**
 * Project a stored `sectionRun` Json onto a {@link SectionRun}, or null.
 *
 * Null on absent, malformed, or unknown-version input, and **null means "not sectioned"**, which
 * resolves to the unsectioned interview. That direction is deliberate and matches
 * `narrowInterviewPlan`: an unreadable blob must widen the respondent's freedom rather than narrow
 * it. Being asked the whole questionnaire in one run is a worse experience than being asked it in
 * parts; being stuck in a section a corrupt blob says you are in is a broken session.
 */
export function narrowSectionRun(value: unknown): SectionRun | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;

  const seen = new Set<string>();
  const sections: SectionRunEntry[] = Array.isArray(value.sections)
    ? value.sections.flatMap((entry): SectionRunEntry[] => {
        if (!isRecord(entry)) return [];
        const key = asText(entry.key, SECTION_KEY_MAX_LENGTH);
        // A duplicate key would make the run ambiguous: two entries claiming one section, and no
        // rule about which one a reader believes. First wins.
        if (key.length === 0 || seen.has(key)) return [];
        if (seen.size >= MAX_TRACKED_SECTIONS) return [];
        seen.add(key);

        const status = narrowSectionEnum(
          typeof entry.status === 'string' ? entry.status : '',
          SECTION_STATUSES,
          'not_started'
        );
        const closedAtTurn =
          typeof entry.closedAtTurn === 'number' && Number.isFinite(entry.closedAtTurn)
            ? asOrdinal(entry.closedAtTurn, 0)
            : null;
        const rawReason = typeof entry.closeReason === 'string' ? entry.closeReason : '';

        return [
          {
            key,
            status,
            openedAtTurn: asOrdinal(entry.openedAtTurn, 0),
            // A stamp on a section that is not closed says nothing true, so it is dropped rather
            // than carried. Same for the reason.
            closedAtTurn: status === 'closed' ? closedAtTurn : null,
            closeReason:
              status === 'closed' && rawReason.length > 0
                ? narrowSectionEnum(rawReason, SECTION_CLOSE_REASONS, 'respondent')
                : null,
            reopenCount: asOrdinal(entry.reopenCount, 0),
            turnsSpent: asOrdinal(entry.turnsSpent, 0),
          },
        ];
      })
    : [];

  const activeKey = asText(value.activeKey, SECTION_KEY_MAX_LENGTH);
  return {
    v: 1,
    // An active key naming a section the run does not track is dropped rather than kept: it would
    // bound the conversation to a section nothing can report on or close.
    activeKey: activeKey.length > 0 && seen.has(activeKey) ? activeKey : null,
    sections,
  };
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bring a run into line with the sections that currently resolve.
 *
 * Called every turn, because the resolved list is not fixed for the life of a session: Conditional
 * Topics seats new topics when the plan lands and a respondent amendment can add one later still,
 * so sections genuinely appear mid-interview. Two rules:
 *
 *  - a resolved section with no entry gains one, `not_started`;
 *  - an entry whose section no longer resolves is **kept, not dropped**, because it may hold a
 *    closed record with turns behind it, and deleting it would orphan those turns' `sectionKey`.
 *    It simply stops being offered.
 *
 * Order follows the resolved list, so the stored blob reads in the order the respondent meets it.
 */
export function reconcileSectionRun(
  run: SectionRun | null,
  sections: readonly InterviewSection[]
): SectionRun {
  const existing = new Map((run?.sections ?? []).map((entry) => [entry.key, entry]));
  const resolved = new Set(sections.map((s) => s.key));

  const ordered: SectionRunEntry[] = sections.map(
    (section) =>
      existing.get(section.key) ?? {
        key: section.key,
        status: 'not_started',
        openedAtTurn: 0,
        closedAtTurn: null,
        closeReason: null,
        reopenCount: 0,
        turnsSpent: 0,
      }
  );

  // Entries for sections that no longer resolve, appended so their history survives.
  for (const entry of run?.sections ?? []) {
    if (!resolved.has(entry.key)) ordered.push(entry);
  }

  const activeKey = run?.activeKey && resolved.has(run.activeKey) ? run.activeKey : null;
  return { v: 1, activeKey, sections: ordered };
}

/**
 * Charge one turn to the section it was spent in.
 *
 * Called once per persisted turn, on the section that was active while it ran. A key the run does
 * not track is a no-op rather than an error: a turn taken in a section that has since stopped
 * resolving still happened, but there is nothing to charge it to.
 */
export function recordTurnInSection(run: SectionRun, key: string): SectionRun {
  if (!sectionEntry(run, key)) return run;
  return {
    ...run,
    sections: run.sections.map((entry) =>
      entry.key === key ? { ...entry, turnsSpent: entry.turnsSpent + 1 } : entry
    ),
  };
}

/** The entry for a key, or null. */
export function sectionEntry(run: SectionRun, key: string): SectionRunEntry | null {
  return run.sections.find((entry) => entry.key === key) ?? null;
}

/**
 * The section the run should be in, choosing one when it has no active section.
 *
 * The first section that is not closed, in resolved order. Returns null when every section is
 * closed, which is the state that says the instrument has been worked through.
 */
export function nextOpenSectionKey(
  run: SectionRun,
  sections: readonly InterviewSection[]
): string | null {
  for (const section of sections) {
    const entry = sectionEntry(run, section.key);
    if (!entry || entry.status !== 'closed') return section.key;
  }
  return null;
}

/**
 * Open a section, whether for the first time or by reopening a closed one.
 *
 * Reopening clears the close stamp and bumps `reopenCount` but keeps `openedAtTurn`: the question
 * that field answers is "where in the transcript does this section start", and the answer does not
 * change because someone came back to it.
 */
export function openSection(run: SectionRun, key: string, atTurn: number): SectionRun {
  const sections = run.sections.map((entry) => {
    if (entry.key !== key) return entry;
    return {
      ...entry,
      status: 'in_progress' as const,
      openedAtTurn: entry.status === 'not_started' ? atTurn : entry.openedAtTurn,
      closedAtTurn: null,
      closeReason: null,
      reopenCount: entry.status === 'closed' ? entry.reopenCount + 1 : entry.reopenCount,
    };
  });
  return { ...run, activeKey: key, sections };
}

/**
 * Close a section and hand the run to the next one that is still open.
 *
 * `activeKey` becomes null when nothing is left, which is what the completion surfaces read as "the
 * instrument has been worked through". Closing a section that is already closed is a no-op rather
 * than an error: a double-tap on the control must not re-stamp the close with a later turn.
 */
export function closeSection(
  run: SectionRun,
  key: string,
  atTurn: number,
  reason: SectionCloseReason,
  sections: readonly InterviewSection[]
): SectionRun {
  const entry = sectionEntry(run, key);
  if (!entry || entry.status === 'closed') return run;

  const closed: SectionRun = {
    ...run,
    sections: run.sections.map((e) =>
      e.key === key
        ? { ...e, status: 'closed' as const, closedAtTurn: atTurn, closeReason: reason }
        : e
    ),
  };

  return { ...closed, activeKey: nextOpenSectionKey(closed, sections) };
}

/** Whether every resolved section has been closed. */
export function allSectionsClosed(run: SectionRun, sections: readonly InterviewSection[]): boolean {
  if (sections.length === 0) return false;
  return sections.every((section) => sectionEntry(run, section.key)?.status === 'closed');
}

/**
 * Whether a respondent may open this section right now.
 *
 * `free` allows any of them. `sequential` allows the active one, any section already VISITED —
 * closed (the reopen right) or left in progress — and the first section that is not closed. It
 * refuses a jump forward past unfinished ground, which is the whole point of the setting.
 *
 * The visited clause is not a loosening of that rule. A section only reaches `in_progress` by
 * having been opened, which required it to be permitted at the time, so nothing new is skipped by
 * letting the respondent return to it. Without the clause, going back to an earlier section to add
 * a line re-locked everything they had already been through: section one reopens, becomes the
 * first-not-closed again, and the section they had just been working in is a padlock. Sequential
 * navigation is there to stop a respondent racing ahead of the interview, not to trap them behind
 * ground they have already covered.
 */
export function canOpenSection(
  run: SectionRun,
  sections: readonly InterviewSection[],
  key: string,
  navigation: 'sequential' | 'free'
): boolean {
  const entry = sectionEntry(run, key);
  if (!entry) return false;
  if (navigation === 'free') return true;
  if (run.activeKey === key) return true;
  if (entry.status !== 'not_started') return true;
  return nextOpenSectionKey(run, sections) === key;
}
