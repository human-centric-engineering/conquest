/**
 * Sectioned interviews (P21) — the per-turn state, and the ONE place sections are decided.
 *
 * `buildTurnContext` calls this beside `buildSessionScope`, and nothing else resolves sections. The
 * reasoning is the one `scope/resolve.ts` already wrote down for itself: filtering at a single
 * choke point rather than in each consumer is what makes a boundary impossible to apply
 * inconsistently. Targeting, the close gate, the panel, the transcript and the report all read what
 * comes out of here.
 *
 * Pure: no Prisma, no Next.
 */

import {
  assessSectionCompletion,
  type SectionCloseAssessment,
} from '@/lib/app/questionnaire/sections/close';
import {
  resolveInterviewSections,
  type ResolverDataSlot,
  type ResolverDocumentSection,
  type SectionScopeFilter,
} from '@/lib/app/questionnaire/sections/resolve';
import {
  narrowSectionRun,
  nextOpenSectionKey,
  reconcileSectionRun,
  sectionEntry,
  type SectionRun,
} from '@/lib/app/questionnaire/sections/run';
import type { SectionedInterviewSettings } from '@/lib/app/questionnaire/sections/settings';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { Topic } from '@/lib/app/questionnaire/scope/types';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/** What {@link buildSectionState} reads. */
export interface SectionStateInput {
  config: QuestionnaireConfigShape;
  settings: SectionedInterviewSettings;
  /** The version's topics, from the already-loaded scope. */
  topics: readonly Topic[];
  conditionalTopicsEnabled: boolean;
  /** UNSCOPED data slots. The scope filter is applied inside, so both lists stay comparable. */
  dataSlots: readonly (ResolverDataSlot & { mappedQuestionKeys?: readonly string[] })[];
  documentSections: readonly ResolverDocumentSection[];
  /** UNSCOPED questions, for the same reason as the data slots. */
  questions: readonly QuestionView[];
  answered: readonly AnsweredView[];
  /** The session's resolved scope, or undefined on a version that is not narrowing anything. */
  scope?: SectionScopeFilter;
  /** The stored `AppQuestionnaireSession.sectionRun`, unparsed. */
  storedRun: unknown;
  sessionId: string;
}

/** Everything the runtime needs to know about sections this turn. */
export interface SectionState {
  /**
   * False when this interview is not sectioned, which is the case for every version that never
   * opted in and every one that resolves to fewer than two sections.
   *
   * Every consumer branches on this ONE flag. While it is false the other fields are inert
   * (`sections` empty, `active` null) and every downstream path sees exactly what it saw pre-P21.
   */
  active: boolean;
  sections: readonly InterviewSection[];
  /** The reconciled run state. Null when not sectioned. */
  run: SectionRun | null;
  /** The section the conversation is bounded to right now. Null when not sectioned, or all closed. */
  activeSection: InterviewSection | null;
  /**
   * True when the active section has had no turn spent in it yet, so the next reply opens it.
   *
   * This is what makes every section start with its own opening question rather than the
   * interviewer walking into new territory mid-stride. Read by the prompt builder as `isOpening`.
   */
  isSectionOpening: boolean;
  /** The close gate for the active section. Null when there is no active section. */
  close: SectionCloseAssessment | null;
  /** True when every resolved section has been closed. */
  allClosed: boolean;
}

/**
 * The inert result: what every unsectioned interview resolves to.
 *
 * Exported because it is also the safe FALLBACK. A caller holding a turn context built by hand (a
 * test harness) or by an older build has no `sectionState`, and a live turn must not break over a
 * derived field whose absence means "not sectioned" — the direction `narrowSectionRun` and
 * `narrowInterviewPlan` already take for the same reason.
 */
export const INERT_SECTION_STATE: SectionState = {
  active: false,
  sections: [],
  run: null,
  activeSection: null,
  isSectionOpening: false,
  close: null,
  allClosed: false,
};

/**
 * Resolve this turn's section state.
 *
 * Returns {@link INERT_SECTION_STATE} whenever the interview is not sectioned. The single early return is
 * deliberate: a consumer that forgot to check `active` still reads an empty section list and a null
 * active section, so the worst it can do is nothing.
 */
export function buildSectionState(input: SectionStateInput): SectionState {
  const questionKeysByDataSlotKey = new Map<string, readonly string[]>(
    input.dataSlots.map((slot) => [slot.key, slot.mappedQuestionKeys ?? []])
  );

  const sections = resolveInterviewSections(
    {
      settings: input.settings,
      topics: input.topics,
      conditionalTopicsEnabled: input.conditionalTopicsEnabled,
      dataSlots: input.dataSlots,
      documentSections: input.documentSections,
      questions: input.questions.map((q) => ({ key: q.key, sectionId: q.sectionId })),
      ...(input.scope ? { scope: input.scope } : {}),
    },
    questionKeysByDataSlotKey
  );

  if (sections.length === 0) return INERT_SECTION_STATE;

  // Reconciled every turn, not just at the start: Conditional Topics seats new topics when the plan
  // lands and a respondent amendment can add one later still, so sections genuinely appear
  // mid-interview. An entry whose section stopped resolving is kept rather than dropped, so the
  // turns already tagged with it are not orphaned.
  const run = reconcileSectionRun(narrowSectionRun(input.storedRun), sections);

  // Choosing an active section here rather than requiring the route to have written one is what
  // lets a session that predates the feature, or one whose first turn has not run, simply start at
  // the beginning.
  const activeKey = run.activeKey ?? nextOpenSectionKey(run, sections);
  const activeSection = activeKey
    ? (sections.find((section) => section.key === activeKey) ?? null)
    : null;

  const allClosed = sections.every(
    (section) => sectionEntry(run, section.key)?.status === 'closed'
  );

  if (!activeSection) {
    return {
      active: true,
      sections,
      run,
      activeSection: null,
      isSectionOpening: false,
      close: null,
      allClosed,
    };
  }

  const entry = sectionEntry(run, activeSection.key);
  return {
    active: true,
    sections,
    run: { ...run, activeKey: activeSection.key },
    activeSection,
    // No turn charged to it yet, so the next reply is this section's opening. True on a reopened
    // section only if nothing was ever said in it, which is the honest reading: an opening question
    // for ground already worked would repeat the conversation back at the respondent.
    isSectionOpening: (entry?.turnsSpent ?? 0) === 0,
    close: assessSectionCompletion({
      section: activeSection,
      questions: input.questions,
      answered: input.answered,
      config: input.config,
      settings: input.settings,
      turnsInSection: entry?.turnsSpent ?? 0,
      sessionId: input.sessionId,
    }),
    allClosed,
  };
}
