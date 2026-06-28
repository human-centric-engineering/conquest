/**
 * Respondent answer-slot panel — pure, serialisable view contracts (F7.2).
 *
 * The shape the `GET …/questionnaire-sessions/:id/answers` endpoint returns and the
 * respondent panel renders. Deliberately a client-safe projection: stable `slotKey`
 * (never the internal cuid), the captured answer + its provenance/confidence, the
 * respondent's own rationale, and the refinement audit trail — but NOT the authoring
 * internals (weight, tags, config, the model's private scoring). What the respondent
 * sees in the panel is what they're already being asked in the conversation.
 *
 * `scope` is the admin's per-version `answerSlotPanelScope` (configuration.md): in
 * `answered_only` the builder omits pending slots and empty sections, so the pending
 * structure is never sent to the client.
 *
 * Prisma-free (the DB read seam is `app/api/v1/app/questionnaire-sessions/_lib/`).
 *
 * `// DEMO-ONLY (F7.2):` the section/slot grouping and provenance vocabulary are
 * questionnaire-domain assumptions — a non-questionnaire fork strips this module.
 */

import type {
  AnswerProvenance,
  AnswerSlotPanelScope,
  QuestionType,
  SessionStatus,
} from '@/lib/app/questionnaire/types';
import type { RefinementHistoryEntry } from '@/lib/app/questionnaire/refinement/types';

/**
 * One refinement-history entry as surfaced to the panel. Mirrors the stored
 * `RefinementHistoryEntry` plus the `createdAt` the persistence seam stamps when it
 * writes the row (the pure core has no clock, so the type leaves it optional).
 */
export type PanelRefinementEntry = RefinementHistoryEntry & { createdAt?: string };

/** One slot in the panel — answer half is null when the slot is still pending. */
export interface PanelSlotView {
  slotKey: string;
  prompt: string;
  type: QuestionType;
  /**
   * The slot's stored `typeConfig` (choices, likert bounds, numeric range, …) or
   * `null`. Carried so the raw form surface (P-presentation) can render the right
   * input control; the chat-side panel ignores it. Opaque JSON — read it via the
   * `lib/app/questionnaire/form/type-config.ts` helpers.
   */
  typeConfig: unknown;
  required: boolean;
  /** True once an answer has been captured for this slot in the session. */
  answered: boolean;
  /** Captured value (null when pending). For free-text this stays the raw answer; the panel shows
   *  {@link paraphrase} instead when present. */
  value: unknown;
  /** Free-text living paraphrase (panel-facing restatement, significant verbatim in quotes), or
   *  null/absent for typed answers and respondent-typed form answers (which render `value` verbatim). */
  paraphrase?: string | null;
  provenance: AnswerProvenance | null;
  /** 0–1; null when unscored (or pending). */
  confidence: number | null;
  rationale: string | null;
  /** 1-based turn that last captured/updated this slot, or null. */
  answeredAtTurnIndex: number | null;
  /** Refinement audit trail, oldest first; empty when never refined. */
  refinementHistory: PanelRefinementEntry[];
}

/**
 * The slot fields an input control actually reads — the key, prompt, and the type + typeConfig that
 * pick and configure the control. A `Pick` of {@link PanelSlotView} so the raw form passes its full
 * slot unchanged, while the inline-correction editor (Variant B) can pass a lighter shape built from
 * a data slot's mapped-question coverage. Lives here (pure) so both the client editor and the pure
 * correction-target builder share one definition.
 */
export type EditableSlot = Pick<PanelSlotView, 'slotKey' | 'prompt' | 'type' | 'typeConfig'>;

/** One section grouping its slots (the panel renders sections in `ordinal` order). */
export interface PanelSectionView {
  sectionId: string;
  title: string;
  slots: PanelSlotView[];
}

/**
 * One prior state of a data-slot fill, stored on the fill's `refinementHistory` Json column and
 * appended whenever a later turn CHANGES the captured value (e.g. "male" → "female"). Lets the
 * panel show how an answer evolved. Oldest first.
 */
export interface DataSlotFillHistoryEntry {
  /** The captured position before this change (free-form). */
  previousValue: unknown;
  /** The restatement shown for that prior value, or null. */
  previousParaphrase: string | null;
  /** The confidence of that prior value, or null. */
  previousConfidence: number | null;
  /**
   * The agent's justification for that prior value at the time, or null when none was recorded.
   * Snapshotted at change-time so the panel's evolution view can show *why* each step read as it
   * did. Optional/absent on entries written before per-change rationale was captured.
   */
  previousRationale?: string | null;
  /** ISO timestamp stamped at the persistence seam when the change was recorded. */
  changedAt?: string;
}

/**
 * One data slot in the respondent panel (Data Slots feature). Shows the short name, the
 * agent's paraphrase of the respondent's position, and a confidence indicator. The underlying
 * question answers stay hidden — the respondent sees only this abstraction layer.
 */
export interface DataSlotPanelSlot {
  key: string;
  name: string;
  description: string;
  /** The agent's restatement of the respondent's position, or null when not yet filled. */
  paraphrase: string | null;
  /**
   * How the position was captured — `direct` (stated), `inferred` (single-step reasoning), or
   * `synthesised` (across turns). Null when not yet filled. The panel flags `inferred`/`synthesised`
   * fills with an "Inferred" marker so a tentative reading isn't read as something the respondent said.
   */
  provenance: AnswerProvenance | null;
  /** 0–1; null when not yet filled. */
  confidence: number | null;
  /** The agent's justification for the captured position — surfaced behind a "Why?" disclosure. Null when not yet filled or none given. */
  rationale: string | null;
  /** True once the slot is covered — a confident fill (≥ threshold) OR a parked provisional one. */
  filled: boolean;
  /**
   * Move-on (Data Slots feature): the fill is a best-effort inference recorded after the agent
   * tried a few times and moved on. Shown as covered with a subtle "provisional · may revisit"
   * marker; a later confident answer clears it.
   */
  provisional: boolean;
  /**
   * 1-based turn that last captured/updated this fill, or null when not yet filled. Mirrors
   * `PanelSlotView.answeredAtTurnIndex`; lets the workspace diff two snapshots to spot the slots a
   * given turn filled (so the panel can scroll to them) without leaking the raw turn count.
   */
  answeredAtTurnIndex: number | null;
  /**
   * Prior states of this slot when the respondent changed their answer, oldest first. Empty when the
   * slot was filled once and never changed. Powers the row's "Edited" affordance, which opens the
   * full evolution (current reading + each prior step's paraphrase, confidence, rationale and time)
   * so a correction (e.g. 25-year-old male → female) is inspectable, not silently overwritten.
   * `rationale`/`changedAt` are null on steps recorded before those were captured.
   */
  history: Array<{
    paraphrase: string | null;
    confidence: number | null;
    rationale: string | null;
    changedAt: string | null;
  }>;
  /**
   * Breadth: how many of this slot's mapped background questions the session has answered. The
   * panel renders `answered`/`total` as a segmented pip meter (always), expandable to the itemised
   * `questions` when `AnswerPanelView.showSlotQuestions` is set (presentationMode `both`).
   */
  coverage: DataSlotCoverage;
}

/**
 * One mapped background question's completeness within this session — a row in a data slot's
 * breadth disclosure (Data Slots feature). The respondent sees these only in `both` presentation
 * mode (where the form view also exposes the questions); chat/form-only never ship the prompts.
 */
export interface DataSlotQuestionCoverage {
  /**
   * Stable question key — the handle the inline-correction editor (Variant B) writes back through
   * `PUT …/answers`. Lets a data-slot "fix" edit the underlying mapped questions; reconciliation
   * then recomputes the slot's reading.
   */
  key: string;
  /** Short question prompt — the label shown in the expanded breadth list / the editor field. */
  label: string;
  /**
   * Question input type + its stored config, so the inline-correction editor can render the right
   * control (the same dispatch the raw form uses). Opaque JSON — read via the
   * `lib/app/questionnaire/form/type-config.ts` helpers.
   */
  type: QuestionType;
  typeConfig: unknown;
  /** True once the session has captured an answer for this question. */
  answered: boolean;
  /** The answer's 0–1 capture confidence, or null when unanswered / unscored. */
  confidence: number | null;
  /** The currently-captured answer value (null when unanswered) — seeds the correction editor. */
  value: unknown;
}

/**
 * How much of a data slot's background-question set the session has answered (Data Slots feature) —
 * the BREADTH axis, deliberately distinct from the fill's `confidence` (the agent's certainty about
 * the captured position). A slot can be confidently filled yet cover only 2 of 5 of its questions;
 * breadth makes that legible where a single confidence figure cannot. The panel renders `answered`/
 * `total` as a segmented pip meter, always. `questions` is itemised only when `showSlotQuestions`.
 */
export interface DataSlotCoverage {
  /** Number of questions mapped to this slot (the meter's denominator). */
  total: number;
  /** How many of them have an answer in this session (the meter's numerator). */
  answered: number;
  /**
   * The mapped questions with per-question completeness, in version order. Populated when the panel
   * may itemise them (presentationMode `both`) OR when inline correction is enabled (Variant B needs
   * the editable questions to "fix" a data-slot reading); empty otherwise, so plain chat/form-only
   * mode still never ships the raw prompts — the `answered`/`total` summary is enough for the meter.
   * The breadth-list DISPLAY stays gated on {@link AnswerPanelView.showSlotQuestions}; correction
   * reads this list directly.
   */
  questions: DataSlotQuestionCoverage[];
}

/** A themed group of data slots (the panel groups by the generator's theme). */
export interface DataSlotPanelGroup {
  theme: string;
  slots: DataSlotPanelSlot[];
}

/** The full panel state for a session. */
export interface AnswerPanelView {
  status: SessionStatus;
  scope: AnswerSlotPanelScope;
  sections: PanelSectionView[];
  /** Count of answered slots (across all sections). */
  answeredCount: number;
  /**
   * Total slots in the version. In `answered_only` scope this still reflects the
   * whole questionnaire, so the panel can show "N captured" without leaking the
   * pending prompts themselves.
   */
  totalCount: number;
  /**
   * Data Slots feature: when present, the panel renders these themed data-slot groups instead
   * of the question sections (the respondent-facing abstraction layer). `answeredCount` /
   * `totalCount` then track the BACKGROUND QUESTIONS (so the header + progress bar reflect the
   * deliverable), while these rows show the data-slot paraphrases + confidence.
   */
  dataSlotGroups?: DataSlotPanelGroup[];
  /**
   * Data Slots feature: a single 0–100 progress figure — the WEIGHTED question coverage
   * (`weightedCoverage` in selection/context.ts), the same completeness figure the reasoning
   * trace's "X% covered so far" shows. Progress is guided by the questions (the deliverable), not
   * by how many data slots are filled. Present only in data-slot mode — the header shows
   * "{progressPercent}% complete" instead of the raw question count, which the respondent never
   * sees. Absent in question mode (the header uses `answeredCount` / `totalCount`).
   */
  progressPercent?: number;
  /**
   * Mean capture confidence (0–1) across every FILLED slot — the data-slot fills in data-slot mode,
   * or the answered question slots in question mode. The header pairs it with completion ("avg
   * confidence 58%") so the respondent sees how sure we are about what we've captured, alongside how
   * much is done. An honest mean over all fills (a tangential, low-confidence fill drags it down by
   * design). Absent (`undefined`) when nothing scored has been captured yet — the header omits it.
   */
  averageConfidence?: number;
  /**
   * Data Slots feature: true when a slot's breadth meter may expand to its underlying questions —
   * i.e. presentationMode is `both`, where the respondent also sees the form, so revealing the
   * mapped prompts doesn't break the chat-mode abstraction. When false/absent the meter still shows
   * the `answered`/`total` summary but does not itemise (and `coverage.questions` is empty).
   */
  showSlotQuestions?: boolean;
}
