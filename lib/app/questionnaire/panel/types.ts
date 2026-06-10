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
  /** 0–1; null when not yet filled. */
  confidence: number | null;
  /** True once a fill (≥ the filled threshold) exists for this slot. */
  filled: boolean;
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
}
