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
  /** Captured value (null when pending). */
  value: unknown;
  provenance: AnswerProvenance | null;
  /** 0–1; null when unscored (or pending). */
  confidence: number | null;
  rationale: string | null;
  /** 1-based turn that last captured/updated this slot, or null. */
  answeredAtTurnIndex: number | null;
  /** Refinement audit trail, oldest first; empty when never refined. */
  refinementHistory: PanelRefinementEntry[];
}

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
   * Prior paraphrases for this slot when the respondent changed their answer, oldest first. Empty
   * when the slot was filled once and never changed. Lets the panel show "Earlier: …" so a
   * correction (e.g. 25-year-old male → female) is visible, not silently overwritten.
   */
  history: Array<{ paraphrase: string | null; confidence: number | null }>;
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
}
