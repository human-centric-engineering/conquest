/**
 * Sectioned interviews (P21) — pure domain types.
 *
 * The vocabulary shared by the section resolver, the close gate, the turn-context seam, the
 * `/sections` route and the respondent tab strip.
 *
 * ## What this feature is
 *
 * A ConQuest interview is one continuous conversation over the whole instrument. Sectioned mode
 * gives it a shape: the conversation is bounded to one section at a time, the respondent navigates
 * between sections, each one opens with its own opening question and closes on its own gate.
 *
 * ## The one invariant
 *
 * **Off by default, inert by construction.** With `sections.enabled` false, or when fewer than
 * {@link MIN_RESOLVED_SECTIONS} sections resolve, nothing here is read and the interview runs
 * exactly as it did before this feature existed.
 *
 * ## Why this module is a leaf
 *
 * `lib/app/questionnaire/types.ts` imports {@link SectionedInterviewSettings}' default object at
 * runtime (the same relationship it has with `scope/types.ts`), so this module and its sibling
 * `settings.ts` must never import back from it. Whichever module evaluated second would read a
 * not-yet-initialised const and throw at import time. That is why `narrowToEnum` is duplicated
 * below rather than imported, exactly as `scope/types.ts` duplicates it and for the same reason.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

import type { TopicPhase } from '@/lib/app/questionnaire/scope/types';

/**
 * Local copy of `narrowToEnum` (`lib/app/questionnaire/types.ts`), deliberately. See the module
 * docblock: importing it would make the cycle real. Three lines duplicated is a cheaper price than
 * a load-order-dependent TDZ crash.
 */
export function narrowSectionEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where a version's sections come from.
 *
 * Three groupings over the same questions already exist and the resolver picks between them rather
 * than introducing a fourth. `'auto'` (on the settings, not here) walks them in this order.
 *
 * - `topics` — Conditional Topics topics. Preferred whenever they
 *   are live, because a topic already carries BOTH question and data-slot membership, an ordinal, a
 *   respondent-facing label, and per-respondent scoping. Seeded one-per-document-section at ingest.
 * - `themes` — the `theme` label on a data slot. What the respondent panel already groups by, and
 *   the common case for a version that has not turned Conditional Topics on.
 * - `document` — the extracted `AppQuestionnaireSection` rows. Truest to the source document, but
 *   it groups questions only: data slots routinely cross a section boundary, so a data-slot-mode
 *   interview sectioned this way has no membership for the thing it actually targets.
 */
export const SECTION_SOURCES = ['topics', 'themes', 'document'] as const;
export type SectionSource = (typeof SECTION_SOURCES)[number];

/** Human labels for the admin's source picker. */
export const SECTION_SOURCE_LABELS: Record<SectionSource, string> = {
  topics: 'Conditional topics',
  themes: 'Data-slot areas',
  document: 'Document sections',
};

/**
 * How the respondent moves between sections.
 *
 * `sequential` is the default because it is the setting an author reaches for this feature to get:
 * an instrument with a genuine order (context, then problem, then appetite) that should be held.
 * `free` is the looser reading, where the tabs are a menu rather than a path.
 */
export const SECTION_NAVIGATIONS = ['sequential', 'free'] as const;
export type SectionNavigation = (typeof SECTION_NAVIGATIONS)[number];

/** Human labels for the navigation selector. */
export const SECTION_NAVIGATION_LABELS: Record<SectionNavigation, string> = {
  sequential: 'In order — finish a section before moving on',
  free: 'Any order — jump between sections freely',
};

/**
 * What happens to an answer that informs a section other than the active one.
 *
 * - `capture` — record it, never chase it. The extractor's VOLUNTEERED TOPICS rule keeps working,
 *   so a respondent who volunteers a strong opinion about something outside the current section is
 *   still heard and the capture shows on that section's tab as progress made in advance. What is
 *   bounded is TARGETING: the interviewer never follows the tangent out of the section.
 * - `stay` — drop it. The strictest reading of "the conversation is bounded by that section". It
 *   costs the respondent's volunteered signal, which is why it is not the default.
 */
export const SECTION_TANGENT_POLICIES = ['capture', 'stay'] as const;
export type SectionTangentPolicy = (typeof SECTION_TANGENT_POLICIES)[number];

/** Human labels for the tangent selector. */
export const SECTION_TANGENT_POLICY_LABELS: Record<SectionTangentPolicy, string> = {
  capture: 'Record it, but stay on this section',
  stay: 'Ignore anything outside this section',
};

/**
 * A section's state within one respondent's run.
 *
 * Note what is NOT here: a terminal state. `closed` is a position in a run, not an end, which is
 * why reopening a section is a plain write and needs none of the eligibility machinery the
 * session-level reopen needs (`isReopenEligible`, its own seam) to cross a genuinely terminal
 * status.
 */
export const SECTION_STATUSES = ['not_started', 'in_progress', 'closed'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/**
 * Why a section closed. Recorded so an admin reading the session timeline can tell the respondent's
 * own decision from the agent's offer from a cap running out.
 *
 * - `respondent` — they pressed the control.
 * - `agent_offer` — they accepted the interviewer's offer to move on.
 * - `cap` — `maxTurnsPerSection` ran out. The escape hatch, and the one reason that says the
 *   section closed without its gate being satisfied.
 * - `auto` — closed by the runtime with nothing left to ask.
 */
export const SECTION_CLOSE_REASONS = ['respondent', 'agent_offer', 'cap', 'auto'] as const;
export type SectionCloseReason = (typeof SECTION_CLOSE_REASONS)[number];

/**
 * Fewest sections that make a sectioned interview.
 *
 * Two, not one. A single section is not a sectioned interview: it is the whole questionnaire with a
 * tab strip above it and a "move on" button that goes nowhere, which is strictly worse than the
 * unsectioned surface. The resolver returns an empty list rather than one section, so every caller
 * falls back to today's behaviour by construction instead of by remembering to check the length.
 */
export const MIN_RESOLVED_SECTIONS = 2;

/* -------------------------------------------------------------------------- */
/* The resolved section                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One section, as every consumer sees it.
 *
 * Membership is KEYS, never row ids, for the same reason a topic's membership is: it survives a
 * version fork with no re-linking, and it is what both `resolveScope` and the orchestrators already
 * speak in.
 */
export interface InterviewSection {
  /** Stable per version: a topic key, a slugified theme, or a document section's id. */
  key: string;
  /** Respondent-facing. A topic's `label`, a theme string, or a section title. */
  label: string;
  /** Position in the run, 0-based and contiguous over the resolved list. */
  ordinal: number;
  /** Which grouping this section was resolved from. Uniform across a resolved list. */
  source: SectionSource;
  questionKeys: readonly string[];
  dataSlotKeys: readonly string[];
  /**
   * The topic phase, on a topic-sourced section only. `opening` is hoisted to the front and
   * `closing` pinned to the back, because those two phases are an ordering statement the author
   * already made and the topic `ordinal` does not necessarily reflect.
   */
  phase?: TopicPhase;
}
