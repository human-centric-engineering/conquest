/**
 * Respondent answer-slot panel — pure projection (F7.2).
 *
 * Joins a version's section/slot structure with the session's captured answers into
 * the serialisable {@link AnswerPanelView} the panel renders. The DB read seam
 * (`app/api/v1/app/questionnaire-sessions/_lib/answer-panel.ts`) loads the plain rows
 * and the turn-id → ordinal map; this function does the join, the scope filter, and
 * the count derivation — no Prisma, no clock, so it unit-tests exhaustively.
 *
 * Scope (`answerSlotPanelScope`, configuration.md):
 *   - `full_progress` — every slot, grouped by section, answered + pending.
 *   - `answered_only` — answered slots only; empty sections dropped, so the pending
 *     prompts are never sent to the client. `totalCount` still reflects the whole
 *     version so the panel can show "N captured" honestly.
 *
 * `// DEMO-ONLY (F7.2):` questionnaire-domain shape — a fork strips this module.
 */

import type {
  AnswerProvenance,
  AnswerSlotPanelScope,
  QuestionType,
  SessionStatus,
} from '@/lib/app/questionnaire/types';
import { ANSWER_PROVENANCES, QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import type {
  AnswerPanelView,
  PanelRefinementEntry,
  PanelSectionView,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

/** A section + its slots, as loaded from the version (ordering already applied). */
export interface PanelSectionInput {
  sectionId: string;
  title: string;
  slots: PanelSlotInput[];
}

/** One slot definition, as loaded from the version. */
export interface PanelSlotInput {
  slotKey: string;
  prompt: string;
  type: string;
  required: boolean;
}

/** One captured answer, keyed back to its slot, as loaded from the session. */
export interface PanelAnswerInput {
  slotKey: string;
  value: unknown;
  provenance: string;
  confidence: number | null;
  rationale: string | null;
  /** 1-based turn that last captured this slot, or null when unmapped. */
  answeredAtTurnIndex: number | null;
  refinementHistory: PanelRefinementEntry[];
}

export interface PanelBuilderInput {
  status: SessionStatus;
  scope: AnswerSlotPanelScope;
  sections: PanelSectionInput[];
  answers: PanelAnswerInput[];
}

/** Narrow a stored question `type` to the enum (default `free_text` when unknown). */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/** Narrow a stored `provenance` to the enum (default `direct` when unknown). */
function asProvenance(value: string): AnswerProvenance {
  return (ANSWER_PROVENANCES as readonly string[]).includes(value)
    ? (value as AnswerProvenance)
    : 'direct';
}

/**
 * Project the loaded structure + answers into the panel view. Pure: deterministic in
 * its inputs, no I/O.
 */
export function buildAnswerPanelView(input: PanelBuilderInput): AnswerPanelView {
  const answerByKey = new Map(input.answers.map((a) => [a.slotKey, a]));

  let answeredCount = 0;
  let totalCount = 0;

  const sections: PanelSectionView[] = [];
  for (const section of input.sections) {
    const slots: PanelSlotView[] = [];
    for (const slot of section.slots) {
      totalCount += 1;
      const answer = answerByKey.get(slot.slotKey);
      const answered = answer !== undefined;
      if (answered) answeredCount += 1;

      // In answered_only scope, never emit a pending slot — its prompt stays server-side.
      if (input.scope === 'answered_only' && !answered) continue;

      slots.push({
        slotKey: slot.slotKey,
        prompt: slot.prompt,
        type: asQuestionType(slot.type),
        required: slot.required,
        answered,
        value: answered ? answer.value : null,
        provenance: answered ? asProvenance(answer.provenance) : null,
        confidence: answered ? answer.confidence : null,
        rationale: answered ? answer.rationale : null,
        answeredAtTurnIndex: answered ? answer.answeredAtTurnIndex : null,
        refinementHistory: answered ? answer.refinementHistory : [],
      });
    }

    // Drop sections that ended up with no rows (only possible in answered_only).
    if (slots.length === 0 && input.scope === 'answered_only') continue;
    sections.push({ sectionId: section.sectionId, title: section.title, slots });
  }

  return {
    status: input.status,
    scope: input.scope,
    sections,
    answeredCount,
    totalCount,
  };
}

/**
 * Weight on data-slot coverage when blending it with background question coverage into one
 * progress figure (the rest weights the questions). `0.5` is an equal balance between the
 * respondent-facing data slots and the background deliverable.
 */
export const DATA_SLOT_PROGRESS_WEIGHT = 0.5;

/**
 * Blend background question coverage with data-slot coverage into a single 0–100 progress percent
 * for the respondent panel (Data Slots feature). Data-slot mode deliberately never shows the raw
 * "N of M" question count — that would leak the question structure the respondent never sees — so
 * this one balanced figure reflects both the deliverable (questions answered in the background) and
 * the conversation's visible progress (data slots filled). An empty side counts as fully covered so
 * a version with only questions, or only data slots, still reports honestly.
 */
export function blendedProgressPercent(input: {
  answeredQuestions: number;
  totalQuestions: number;
  filledDataSlots: number;
  totalDataSlots: number;
}): number {
  const qCov = input.totalQuestions === 0 ? 1 : input.answeredQuestions / input.totalQuestions;
  const dCov = input.totalDataSlots === 0 ? 1 : input.filledDataSlots / input.totalDataSlots;
  const w = DATA_SLOT_PROGRESS_WEIGHT;
  const blended = qCov * (1 - w) + dCov * w;
  return Math.round(Math.min(1, Math.max(0, blended)) * 100);
}
