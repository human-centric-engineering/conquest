/**
 * Answer-refinement contract and in-memory shapes (F4.4).
 *
 * Over a long conversation a respondent's earlier answer can need updating in light
 * of later context — they reconcile a contradiction F4.3 surfaced, or simply clarify
 * something they said before. This module owns the pure, DB-free shapes for the pass
 * that *decides* whether (and how) to update an already-captured answer.
 *
 * Unlike F4.1–F4.3, F4.4 also introduces the persistence foundation
 * (`AppQuestionnaireSession`/`AppAnswerSlot`), so a refinement is ultimately
 * **written**. But this core stays pure: the LLM decision and the value-merge logic
 * are data-in / data-out, with no Prisma / Next import. The route's `_lib` seam loads
 * the existing answer, calls {@link applyRefinement}, and persists the result.
 *
 * The split mirrors F4.2/F4.3: the LLM emits structurally-checked decisions
 * (`refinement-schema.ts`); `refinement-logic.ts` resolves them against the context,
 * dropping one odd decision rather than failing the pass; {@link applyRefinement}
 * deterministically produces the new slot state.
 */

import type { AnswerProvenance, QuestionType } from '@/lib/app/questionnaire/types';

/**
 * What the refiner decides for one slot — core-internal vocabulary, so the tuple
 * lives here (not in the shared `../types.ts`), the same way
 * `CONTRADICTION_SEVERITIES` is detector-local. A `const` tuple so the Zod contract
 * enum and the normaliser derive from one source.
 *
 * - `refine` — the value genuinely evolves with later context (the canonical case:
 *   contradiction resolution, "earlier I rounded, it's actually 34"). Provenance
 *   becomes `refined`; a history entry preserves the prior value.
 * - `overwrite` — a straight correction of a mistaken capture (typo, wrong option,
 *   model mis-extraction). The prior value was never *meant*, so provenance is
 *   **kept** (a typo fix isn't an evolution) — but a history entry is still appended
 *   so the prior value isn't silently lost.
 * - `leave` — new context doesn't change this slot. A no-op, filtered out by the
 *   normaliser so it never reaches {@link applyRefinement}.
 */
export const REFINEMENT_ACTIONS = ['refine', 'overwrite', 'leave'] as const;
export type RefinementAction = (typeof REFINEMENT_ACTIONS)[number];

/**
 * Why a refinement happened — labels the {@link RefinementHistoryEntry} for audit.
 * `contradiction` and `clarification` accompany a `refine` (a genuine evolution);
 * `correction` accompanies an `overwrite` (a mistaken capture being fixed). A
 * `const` tuple for the same single-source reason as {@link REFINEMENT_ACTIONS}.
 */
export const REFINEMENT_SOURCES = ['contradiction', 'clarification', 'correction'] as const;
export type RefinementSource = (typeof REFINEMENT_SOURCES)[number];

/**
 * A question slot projected into the shape the refiner reads. The caller maps
 * `AppQuestionSlot` (+ its section) into this — the refiner sees no Prisma rows.
 * Carries `prompt` and `typeConfig` because judging a refinement and validating the
 * new value need the question's meaning and its option/scale vocabulary.
 */
export interface RefinementSlotView {
  /** `AppQuestionSlot.id`. Optional on the pure path (slots addressed by `key`); the
   *  route's DB-derived context carries it through so the persistence seam can write
   *  without a second lookup. */
  id?: string;
  /** Stable per-version slug — how decisions address a slot. */
  key: string;
  /** `AppQuestionnaireSection.id` the slot belongs to. Optional, as for `id`. */
  sectionId?: string;
  /** The question type; gives the refiner the shape of the value and drives value
   *  validation. */
  type: QuestionType;
  /** The slot's stored `typeConfig` (choices, likert bounds, …) or `null`. */
  typeConfig: unknown;
  /** The question prompt — the refiner needs it to reason about the update. */
  prompt: string;
  /** Author guidance on how to interpret answers; passed to the LLM when present. */
  guidelines?: string;
  /** Whether an answer is mandatory; surfaced to the LLM as priority context. */
  required: boolean;
}

/**
 * An answer already captured this session — the unit the refiner may update. Richer
 * than F4.3's `AnsweredSlotView`: it carries the existing `provenance`, `rationale`
 * and prior `refinementHistory` so {@link applyRefinement} can preserve and extend
 * them rather than clobbering the audit trail.
 */
export interface ExistingAnswerView {
  /** `RefinementSlotView.key` this answer belongs to. */
  slotKey: string;
  /** The currently-recorded value. */
  value: unknown;
  /** How the current value was arrived at — the label a `refine` transitions to
   *  `refined` and an `overwrite` preserves. */
  provenance: AnswerProvenance;
  /** The current value's short justification, if any. */
  rationale?: string;
  /** Capture confidence 0–1, or `null`/absent when not scored. */
  confidence?: number | null;
  /** Which turn captured the current value (F4.6 seam). */
  turnIndex?: number;
  /** Prior refinements of this slot, oldest first — extended, not replaced. */
  refinementHistory?: RefinementHistoryEntry[];
}

/**
 * One entry appended to a slot's `refinementHistory` when it is refined or
 * overwritten — a self-describing audit record of the change. Captures the
 * *pre-change* value/provenance alongside the new value so a reviewer can replay
 * how the answer evolved.
 *
 * **No `timestamp`**: the pure core has no clock (`Date.now()` is also unavailable
 * to keep replays deterministic). The persistence seam stamps `createdAt` when it
 * writes the row, exactly as it resolves `slotKey → id`. `turnIndex` is optional and
 * caller-supplied — the real turn loop (F4.6) provides it.
 */
export interface RefinementHistoryEntry {
  previousValue: unknown;
  previousProvenance: AnswerProvenance;
  newValue: unknown;
  rationale: string;
  source: RefinementSource;
  turnIndex?: number;
}

/**
 * Everything the refiner reads for one pass — entirely in-memory.
 */
export interface RefinementContext {
  /** The version's slot definitions (capped by the caller), indexed by `key`. */
  slots: RefinementSlotView[];
  /** The already-answered slots eligible to be refined. */
  existingAnswers: ExistingAnswerView[];
  /** The new respondent message that may justify a refinement. Optional — a pass can
   *  be driven purely by a triggering contradiction. */
  userMessage?: string;
  /** The F4.3 finding that triggered this pass; its `suggestedProbe` is the handoff
   *  from detection to refinement. */
  triggeringContradiction?: {
    slotKeys: string[];
    explanation: string;
    suggestedProbe?: string;
  };
  /** Recent transcript lines for context, most recent last. */
  recentMessages?: string[];
  /** Stable session identity — threaded into cost-log metadata. */
  sessionId: string;
}

/**
 * A normalised, version-agnostic refinement decision the apply step consumes — the
 * F4.4 analogue of F4.2's `AnswerSlotIntent`. Only `refine`/`overwrite` reach here;
 * the normaliser filters `leave` out (there is nothing to apply).
 */
export interface RefinementDecision {
  /** The slot to update (resolves to an answered `RefinementSlotView.key`). */
  slotKey: string;
  /** The action — never `leave` (filtered by the normaliser). */
  action: Exclude<RefinementAction, 'leave'>;
  /** The slot's REAL type (from the context), never the LLM's self-declared claim. */
  questionType: QuestionType;
  /** The validated, per-type-normalised new value. */
  newValue: unknown;
  /** Short justification for the change. */
  rationale: string;
  /** Why the change happened — labels the history entry. */
  source: RefinementSource;
  /** The refiner's certainty the change is correct, 0–1. */
  confidence: number;
}

/**
 * The in-memory slot state {@link applyRefinement} returns. The persistence seam
 * maps this to a Prisma update (set `value`/`provenanceLabel`, replace the
 * `refinementHistory` JSON with the extended list).
 */
export interface RefinedSlotState {
  slotKey: string;
  value: unknown;
  provenance: AnswerProvenance;
  /** The refiner's certainty in the new value (from the decision) — a refinement can
   *  raise (or lower) the slot's confidence, since improving a low-confidence capture is
   *  the point of refining. The persistence seam writes this onto the row. */
  confidence: number;
  refinementHistory: RefinementHistoryEntry[];
}

/** A raw decision dropped by the normaliser, with why — for logging. */
export interface DroppedRefinement {
  slotKey: string;
  reason: string;
}

/**
 * Output of `normalizeRefinementDecisions`: the coherent decisions ready to apply,
 * plus the records removed and why. Mirrors F4.2's `{ intents, dropped }`.
 */
export interface RefinementResult {
  decisions: RefinementDecision[];
  dropped: DroppedRefinement[];
}

/**
 * A counts-only roll-up of a refinement pass — the shape the preview route returns
 * as its `summary` and the capability's PII-safe `redactProvenance` preview embeds.
 * Carries no values/rationales, so it's safe to surface anywhere. Built by
 * `summarizeRefinements` so those two call sites can't drift apart.
 */
export interface RefinementSummary {
  refineCount: number;
  overwriteCount: number;
  droppedCount: number;
}
