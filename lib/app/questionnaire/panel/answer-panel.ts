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
 *   - `hidden` — the surface renders no panel at all (chat only). Projected exactly like
 *     `answered_only` rather than emptied: the captured answers are what the chat's inline
 *     correction strip edits and what the completion screen echoes back, and neither of those
 *     is governed by this setting. Pending prompts stay server-side, same as `answered_only`.
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
import { sharedReason } from '@/lib/app/questionnaire/scope/reasons';
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
  /**
   * Stored `typeConfig` (opaque JSON) — carried through for the raw form surface.
   * Optional: callers that don't render a form (e.g. the PDF/export builders) omit
   * it and the view defaults to `null`.
   */
  typeConfig?: unknown;
  required: boolean;
  /**
   * F17.33: why this question is in the respondent's interview, when Conditional Topics is what put
   * it there. Absent on every question of an ordinary questionnaire, and on every always-run one.
   */
  addedReason?: string | null;
}

/** One captured answer, keyed back to its slot, as loaded from the session. */
export interface PanelAnswerInput {
  slotKey: string;
  value: unknown;
  /** Free-text living paraphrase (panel-facing); null/absent for typed answers / respondent-typed forms. */
  paraphrase?: string | null;
  provenance: string;
  confidence: number | null;
  rationale: string | null;
  /**
   * True when the respondent set/edited this answer themselves in form view (`AppAnswerSlot.
   * respondentEdited`). Optional: only the live panel seam loads it; the export/report builders
   * omit it (their surfaces don't render the interactive "captured" ⓘ) and it defaults to `false`.
   */
  respondentEdited?: boolean;
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

  // Both `answered_only` and `hidden` project identically (see the module docblock): pending
  // prompts never leave the server. Named once so the two call sites below can't drift on what
  // "outside full_progress" means to a future third scope value.
  const answeredOnlyProjection = input.scope !== 'full_progress';

  const sections: PanelSectionView[] = [];
  for (const section of input.sections) {
    const slots: PanelSlotView[] = [];
    for (const slot of section.slots) {
      totalCount += 1;
      const answer = answerByKey.get(slot.slotKey);
      const answered = answer !== undefined;
      if (answered) answeredCount += 1;

      // Outside full_progress, never emit a pending slot — its prompt stays server-side.
      if (answeredOnlyProjection && !answered) continue;

      slots.push({
        slotKey: slot.slotKey,
        prompt: slot.prompt,
        type: asQuestionType(slot.type),
        // Carried through unchanged; the section may absorb it below when every slot agrees.
        ...(slot.addedReason ? { addedReason: slot.addedReason } : {}),
        typeConfig: slot.typeConfig ?? null,
        required: slot.required,
        answered,
        value: answered ? answer.value : null,
        paraphrase: answered ? (answer.paraphrase ?? null) : null,
        provenance: answered ? asProvenance(answer.provenance) : null,
        confidence: answered ? answer.confidence : null,
        rationale: answered ? answer.rationale : null,
        respondentEdited: answered ? (answer.respondentEdited ?? false) : false,
        answeredAtTurnIndex: answered ? answer.answeredAtTurnIndex : null,
        refinementHistory: answered ? answer.refinementHistory : [],
      });
    }

    // Drop sections that ended up with no rows (impossible in full_progress).
    if (slots.length === 0 && answeredOnlyProjection) continue;
    // F17.33: one line under the heading when the whole section arrived together, rather than the
    // same sentence repeated on every row. Computed over the slots the respondent will actually
    // SEE, so a section whose added rows are filtered out by `answered_only` does not caption
    // itself with an explanation for rows that are not on screen.
    const shared = sharedReason(slots.map((slot) => slot.addedReason ?? null));
    sections.push({
      sectionId: section.sectionId,
      title: section.title,
      slots: shared
        ? // The group says it once; the rows stop repeating it.
          slots.map(({ addedReason: _absorbed, ...rest }) => rest)
        : slots,
      ...(shared ? { addedReason: shared } : {}),
    });
  }

  return {
    status: input.status,
    scope: input.scope,
    sections,
    answeredCount,
    totalCount,
  };
}

// Data-slot mode's progress percent (`AnswerPanelView.progressPercent`) is computed in the route
// seam as the WEIGHTED question coverage (`weightedCoverage` in selection/context.ts) — the same
// completeness figure the reasoning trace's "X% covered so far" shows. Progress is guided by the
// questions (the deliverable), not by how many data slots are filled, so the panel and the
// reasoning trace never report different numbers.
