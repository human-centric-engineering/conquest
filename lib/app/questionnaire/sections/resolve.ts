/**
 * Sectioned interviews (P21) — "what are this version's sections, and which of them apply here?"
 *
 * The single function every caller routes through, and the only place the source ladder is
 * decided. Pure: no Prisma, no Next, no I/O. Callers hand it the version's three candidate
 * groupings plus the session's already-resolved scope, and get back an ordered list.
 *
 * ## The inert guarantee
 *
 * Three conditions return the EMPTY list, which every caller reads as "this interview is not
 * sectioned" and which restores the pre-P21 behaviour exactly:
 *
 *  1. `settings.enabled` is false (the version never opted in),
 *  2. no grouping yields anything, or
 *  3. fewer than {@link MIN_RESOLVED_SECTIONS} sections survive.
 *
 * The third is the one worth stating: a one-section interview is not a sectioned interview, it is
 * the whole questionnaire with a tab strip above it and a "move on" control that goes nowhere.
 * Returning `[]` rather than `[theOnlySection]` means no caller has to remember to check the length.
 *
 * ## Why scope is an input rather than something this resolves
 *
 * Conditional Topics decides WHAT applies to a respondent; sections decide the ORDER and the
 * BOUNDARY. Keeping the two apart is what stops sectioning becoming a second scope mechanism: this
 * function can narrow a section's membership to what scope already allowed, and can drop a section
 * scope emptied, but it can never put a key back that scope left out.
 */

import { nextAvailableKey, slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import {
  MIN_RESOLVED_SECTIONS,
  type InterviewSection,
  type SectionSource,
} from '@/lib/app/questionnaire/sections/types';
import type { SectionedInterviewSettings } from '@/lib/app/questionnaire/sections/settings';
import { ALWAYS_PHASES, type Topic, type TopicPhase } from '@/lib/app/questionnaire/scope/types';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** A data slot as the resolver reads it. */
export interface ResolverDataSlot {
  key: string;
  /** The generator's grouping label. Blank or absent means the slot groups with nothing. */
  theme: string | null;
  ordinal: number;
}

/** A document section as the resolver reads it. */
export interface ResolverDocumentSection {
  id: string;
  title: string;
  ordinal: number;
}

/** A question as the resolver reads it. */
export interface ResolverQuestion {
  key: string;
  sectionId: string;
}

/**
 * The already-resolved scope, when there is one.
 *
 * Structural rather than `ResolvedScope` itself so a caller can pass a narrower object and so this
 * module does not depend on `scope/resolve.ts`. `ResolvedScope` satisfies it as it stands.
 */
export interface SectionScopeFilter {
  questionKeys: ReadonlySet<string>;
  dataSlotKeys: ReadonlySet<string>;
}

export interface SectionResolverInput {
  settings: SectionedInterviewSettings;
  /** The version's topics, in authored order. Empty on a version that has never been ingested. */
  topics: readonly Topic[];
  /** The version's `conditionalTopics.enabled`. Gates the `topics` rung of the ladder. */
  conditionalTopicsEnabled: boolean;
  dataSlots: readonly ResolverDataSlot[];
  documentSections: readonly ResolverDocumentSection[];
  questions: readonly ResolverQuestion[];
  /**
   * Restrict every section's membership to these keys, and drop the sections left empty. Omit on
   * an unscoped read (the admin's "what will respondents see" preview); pass the session's resolved
   * scope on every runtime path.
   */
  scope?: SectionScopeFilter;
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which grouping this version's sections come from, or `null` when none of them can supply any.
 *
 * Exported so the admin surface can say what respondents will actually see without building the
 * whole list, and so the reason a version is not sectioned is legible rather than inferred.
 *
 * `'auto'` walks topics, then themes, then document sections. The order is not arbitrary: a topic
 * carries BOTH question and data-slot membership, a theme carries data slots only, and a document
 * section carries questions only. Each rung down is a grouping that knows less about the thing the
 * conversation actually targets.
 */
export function resolveSectionSource(input: SectionResolverInput): SectionSource | null {
  const { settings } = input;

  const topicsAvailable = input.conditionalTopicsEnabled && input.topics.length > 0;
  const themesAvailable = input.dataSlots.some((s) => (s.theme ?? '').trim().length > 0);
  const documentAvailable = input.documentSections.length > 0 && input.questions.length > 0;

  if (settings.source !== 'auto') {
    // An explicit pin is honoured only when that grouping can actually supply sections. Falling
    // through to the ladder is deliberate: an author who pinned `topics` and later turned
    // Conditional Topics off should get a working sectioned interview, not an unsectioned one that
    // silently ignores the rest of their settings.
    if (settings.source === 'topics' && topicsAvailable) return 'topics';
    if (settings.source === 'themes' && themesAvailable) return 'themes';
    if (settings.source === 'document' && documentAvailable) return 'document';
  }

  if (topicsAvailable) return 'topics';
  if (themesAvailable) return 'themes';
  if (documentAvailable) return 'document';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Per-source builders                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sort key for a topic-sourced section.
 *
 * `opening` first and `closing` last, whatever their ordinals say. The phase is an ordering
 * statement the author already made ("runs first", "always ask, last"), and the topic `ordinal` is
 * a list position that need not agree with it. `core` and `conditional` sit between, in ordinal
 * order, because nothing distinguishes them from each other in time.
 */
function phaseRank(phase: TopicPhase): number {
  if (phase === 'opening') return 0;
  if (phase === 'closing') return 2;
  return 1;
}

function fromTopics(topics: readonly Topic[]): InterviewSection[] {
  return [...topics]
    .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.ordinal - b.ordinal)
    .map((topic, index) => ({
      key: topic.key,
      label: topic.label,
      ordinal: index,
      source: 'topics' as const,
      questionKeys: topic.members.questionKeys,
      dataSlotKeys: topic.members.dataSlotKeys,
      phase: topic.phase,
    }));
}

/**
 * Group data slots by their `theme`, ordering the groups by the lowest ordinal each one holds.
 *
 * Ordering by `min(ordinal)` rather than first-seen keeps the result independent of the order rows
 * came back in, and it puts a theme where its earliest slot sits, which is where the generator meant
 * that area to come up.
 *
 * Themes are matched EXACTLY, the same comparison the respondent panel already groups by, so a
 * section here and a group in the panel can never disagree about what belongs together.
 */
function fromThemes(
  dataSlots: readonly ResolverDataSlot[],
  questionKeysByDataSlotKey: ReadonlyMap<string, readonly string[]>
): InterviewSection[] {
  const groups = new Map<string, { minOrdinal: number; slotKeys: string[] }>();

  // Ordinal order WITHIN a theme as well as between them. Without this the slots (and therefore the
  // section's question list, and the order the panel walks) would follow whatever order the rows
  // came back in, which is a query detail rather than anything the author decided.
  const ordered = [...dataSlots].sort((a, b) => a.ordinal - b.ordinal);

  for (const slot of ordered) {
    const theme = (slot.theme ?? '').trim();
    // A slot with no theme groups with nothing. Bundling the themeless ones into a catch-all
    // section would invent an area the author never named and put it in the respondent's tab strip.
    if (theme.length === 0) continue;
    const group = groups.get(theme);
    if (group) {
      group.slotKeys.push(slot.key);
      group.minOrdinal = Math.min(group.minOrdinal, slot.ordinal);
    } else {
      groups.set(theme, { minOrdinal: slot.ordinal, slotKeys: [slot.key] });
    }
  }

  const taken = new Set<string>();
  return [...groups.entries()]
    .sort(([aTheme, a], [bTheme, b]) => a.minOrdinal - b.minOrdinal || aTheme.localeCompare(bTheme))
    .map(([theme, group], index) => {
      // Slugified so the key is safe in a URL, a DOM id and a stored `sectionRun` entry. Deduped
      // because two distinct themes can slugify to the same string ("Go to market" / "Go-to-market")
      // and two sections sharing a key would make the run state ambiguous.
      const key = nextAvailableKey(slugifyKey(theme), taken);
      taken.add(key);

      const questionKeys: string[] = [];
      for (const slotKey of group.slotKeys) {
        for (const qKey of questionKeysByDataSlotKey.get(slotKey) ?? []) {
          if (!questionKeys.includes(qKey)) questionKeys.push(qKey);
        }
      }

      return {
        key,
        label: theme,
        ordinal: index,
        source: 'themes' as const,
        questionKeys,
        dataSlotKeys: group.slotKeys,
      };
    });
}

function fromDocument(
  documentSections: readonly ResolverDocumentSection[],
  questions: readonly ResolverQuestion[]
): InterviewSection[] {
  const keysBySection = new Map<string, string[]>();
  for (const q of questions) {
    const list = keysBySection.get(q.sectionId);
    if (list) list.push(q.key);
    else keysBySection.set(q.sectionId, [q.key]);
  }

  return (
    [...documentSections]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((section) => ({ section, questionKeys: keysBySection.get(section.id) ?? [] }))
      // A section with no questions is dropped here rather than after the scope filter, matching
      // `planSeededTopics`, which skips an empty section for the same reason: it can never be worked
      // through, so offering it as a tab is offering a dead end.
      .filter(({ questionKeys }) => questionKeys.length > 0)
      .map(({ section, questionKeys }, index) => ({
        key: section.id,
        label: section.title.trim() || `Section ${index + 1}`,
        ordinal: index,
        source: 'document' as const,
        questionKeys,
        // Document sections group questions only. A data-slot-mode interview sectioned this way has
        // no slot membership to target, which is exactly why this is the last rung of the ladder.
        dataSlotKeys: [],
      }))
  );
}

/* -------------------------------------------------------------------------- */
/* The resolver                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve this version's sections for this session, in the order the respondent works through them.
 *
 * Returns `[]` whenever the interview is not sectioned. See the module docblock for the three ways
 * that happens.
 *
 * `questionKeysByDataSlotKey` is the `AppDataSlotQuestion` mapping, needed only by the `themes`
 * source: a theme groups data slots, and the close gate measures QUESTIONS, so a theme-sourced
 * section has to carry the questions its slots abstract over or its gate would have nothing to
 * assess.
 */
export function resolveInterviewSections(
  input: SectionResolverInput,
  questionKeysByDataSlotKey: ReadonlyMap<string, readonly string[]> = new Map()
): InterviewSection[] {
  if (!input.settings.enabled) return [];

  const source = resolveSectionSource(input);
  if (source === null) return [];

  const built =
    source === 'topics'
      ? fromTopics(input.topics)
      : source === 'themes'
        ? fromThemes(input.dataSlots, questionKeysByDataSlotKey)
        : fromDocument(input.documentSections, input.questions);

  const scoped = input.scope ? applyScope(built, input.scope) : built;

  // Renumber AFTER the scope filter so `ordinal` is contiguous over what the respondent actually
  // sees. A gap in the numbering would be visible the moment anything renders "section 3 of 7".
  const sections = scoped.map((section, index) => ({ ...section, ordinal: index }));

  return sections.length >= MIN_RESOLVED_SECTIONS ? sections : [];
}

/**
 * Narrow each section to the keys scope allows, dropping any left with nothing.
 *
 * Only ever narrows. A key scope excluded cannot be reintroduced here, which is the invariant that
 * keeps sections from becoming a second way to decide what a respondent is asked.
 */
function applyScope(
  sections: readonly InterviewSection[],
  scope: SectionScopeFilter
): InterviewSection[] {
  const out: InterviewSection[] = [];
  for (const section of sections) {
    const questionKeys = section.questionKeys.filter((k) => scope.questionKeys.has(k));
    const dataSlotKeys = section.dataSlotKeys.filter((k) => scope.dataSlotKeys.has(k));
    if (questionKeys.length === 0 && dataSlotKeys.length === 0) continue;
    out.push({ ...section, questionKeys, dataSlotKeys });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

/** `question key -> section key`, for grouping turns, panel rows and report chapters. */
export function sectionByQuestionKey(
  sections: readonly InterviewSection[]
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    // First wins, so a key claimed by two sections lands in the earlier one rather than flipping
    // with iteration order. Topic membership genuinely overlaps (a question may sit in several
    // topics), and a question can only be worked through once.
    for (const key of section.questionKeys) if (!map.has(key)) map.set(key, section.key);
  }
  return map;
}

/** `data-slot key -> section key`. Same first-wins rule, same reason. */
export function sectionByDataSlotKey(
  sections: readonly InterviewSection[]
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    for (const key of section.dataSlotKeys) if (!map.has(key)) map.set(key, section.key);
  }
  return map;
}

/**
 * The always-run phases, re-exported so a caller reasoning about section order does not have to
 * reach into the scope module for the one constant the two features share.
 */
export { ALWAYS_PHASES };
