/**
 * Answer-extraction contract and in-memory shapes (F4.2).
 *
 * The conversational engine asks one question at a time; when a respondent
 * replies, an *answer extractor* turns that message into typed values for one or
 * more slots — the active question plus any others the message happens to answer
 * (a *side-effect*). This module owns the pure, DB-free shapes that flow through
 * that pass.
 *
 * **Pure by design.** Session/turn/answer tables don't exist yet (they land in
 * F4.6/P6), exactly as for selection (F4.1). So extraction never touches Prisma:
 * a caller (a Vitest harness today, the streaming engine later) assembles an
 * in-memory {@link ExtractionContext}, and the extractor returns version-agnostic
 * {@link AnswerSlotIntent}s — write *intents*, not rows. F4.6 resolves each
 * `slotKey` to an `AppQuestionSlot.id` and persists. This mirrors F1.1's split
 * between the raw LLM contract and the `ChangeRecordIntent[]` the route persists.
 */

import type { AnswerProvenance, QuestionType } from '@/lib/app/questionnaire/types';

/**
 * A question slot projected into the shape the extractor reads. The caller maps
 * `AppQuestionSlot` (+ its section) into this — the extractor sees no Prisma rows.
 * Richer than selection's `QuestionView`: the extractor needs the `prompt` (to
 * judge which slot a message answers) and the `typeConfig` (to validate the
 * extracted value against the slot's real choices / bounds).
 */
export interface ExtractionSlotView {
  /**
   * `AppQuestionSlot.id`. Optional: the pure extraction path (prompt + normaliser)
   * addresses slots by `key` and never reads the id — the route's DB-derived
   * context carries it through so F4.6 can persist without a second lookup.
   */
  id?: string;
  /** Stable per-version slug — how intents address a slot (no IDs pre-persist). */
  key: string;
  /** `AppQuestionnaireSection.id` the slot belongs to. Optional for the same reason as `id`. */
  sectionId?: string;
  /** The question type; drives per-type value validation. */
  type: QuestionType;
  /**
   * The slot's stored `typeConfig` (choices, likert bounds, …) or `null` for
   * config-less types. Read by `validateAnswerValue` to enforce choice
   * membership / numeric bounds against this slot specifically.
   */
  typeConfig: unknown;
  /** The question prompt — the LLM needs it to decide which slot a message answers. */
  prompt: string;
  /** Author guidance on how to interpret answers; passed to the LLM when present. */
  guidelines?: string;
  /** Whether an answer is mandatory; surfaced to the LLM as priority context. */
  required: boolean;
  /**
   * Free-text comment fields: the slot's CURRENT living paraphrase this session (when any), so the
   * extractor integrates new tangential mentions into it rather than starting over — the paraphrase
   * builds up across turns. Absent until the slot has a paraphrase, and for non-free-text slots.
   */
  currentParaphrase?: string | null;
}

/** One answer already captured this session — so the extractor doesn't re-ask. */
export interface ExtractionAnsweredView {
  /** `ExtractionSlotView.key` that already has an answer. */
  slotKey: string;
  /** Extraction confidence 0–1, or `null` when not scored. */
  confidence: number | null;
}

/**
 * Everything the extractor reads to process one turn — entirely in-memory.
 */
export interface ExtractionContext {
  /**
   * The question currently being asked. The message primarily answers this; the
   * key must resolve to one of {@link candidateSlots}. `null` in DATA-SLOT MODE,
   * where the respondent is answering an open conversational prompt (a data slot)
   * rather than one fixed question — the extractor then captures every question +
   * data slot the message supports, with no single "active" question to privilege.
   */
  activeQuestionKey: string | null;
  /**
   * Every slot a value could be extracted into this turn — the active slot plus
   * the version's unanswered slots (re-answering an answered slot is F4.4's
   * `refined` job). The caller caps the list to bound prompt size / cost.
   */
  candidateSlots: ExtractionSlotView[];
  /** Answers captured so far this session (keyed by slot key). */
  answered: ExtractionAnsweredView[];
  /** The respondent's message to extract from (the current turn). */
  userMessage: string;
  /**
   * Data Slots feature: the version's data slots to ALSO fill this turn (the abstraction
   * layer). When present, the extractor emits `dataSlotFills` alongside the question answers
   * in one call. Absent in question-only mode (the prompt then omits the data-slot section).
   */
  dataSlotCandidates?: DataSlotCandidateView[];
  /**
   * Recent transcript, oldest → newest, for disambiguating references. Optional;
   * the extractor works off `userMessage` alone when absent.
   */
  recentMessages?: string[];
  /**
   * Files the respondent attached to this turn (images / documents), base64-encoded.
   * When present the prompt builder turns the user message into multimodal content
   * parts so the extractor can read the attachment alongside the text. Shape mirrors
   * the platform `chatAttachmentSchema`.
   */
  attachments?: ExtractionAttachment[];
  /** Stable session identity — threaded into cost-log metadata. */
  sessionId: string;
  /**
   * Sensitivity awareness / safeguarding: when true, the prompt asks the extractor to ALSO emit a
   * `sensitivity` assessment for a genuine sensitive/contentious disclosure. Off (the default) adds
   * no prompt text and no behaviour, so the feature is zero-cost when disabled. The route sets this
   * from the platform flag AND the per-questionnaire config toggle.
   */
  sensitivityAware?: boolean;
  /**
   * Answer-fit resolver pass: when true, the prompt is reframed as a focused SECOND call over a
   * small set of choice/likert questions the respondent already addressed but the first pass
   * couldn't map. It instructs the model to commit to the single best-fitting option/scale point
   * (or omit only when there's genuinely no fit), rather than re-running open extraction. Set by
   * the extractor capability for the fit pass; never on the primary call.
   */
  forceFit?: boolean;
}

/** One base64-encoded attachment on a respondent turn (mirrors `chatAttachmentSchema`). */
export interface ExtractionAttachment {
  name: string;
  mediaType: string;
  data: string;
}

/**
 * A data slot projected into the shape the extractor reads (Data Slots feature). When present
 * in the {@link ExtractionContext}, the extractor ALSO scans the message for data-slot fills —
 * the respondent-facing capture — alongside the background question answers, in the same call.
 */
export interface DataSlotCandidateView {
  /** Stable per-version slug — how fills address a slot. */
  key: string;
  /** Short (1–4 word) name — the human target. */
  name: string;
  /** What the slot captures + why (guides what counts as filled). */
  description: string;
  /** Group label (for the model's sense of the area). */
  theme: string;
  /**
   * Keys of the candidate questions this slot "meaningfully captures" (the `AppDataSlotQuestion`
   * mapping). When present, the extractor that fills this slot must ALSO answer these mapped
   * questions — translating the captured position onto each question's type/scale/options — so a
   * conversational answer flows onto the underlying form, not just the panel. Each key is also in
   * the candidate-question list (where its type/options live); absent/empty when the slot maps to
   * no question.
   */
  mappedQuestionKeys?: string[];
  /**
   * What's already recorded for this slot this session, when any — so the extractor can UPDATE or
   * CORRECT it (merge still-true details with a correction) rather than re-deriving from scratch
   * and dropping prior detail. Absent until the slot has a fill.
   */
  current?: {
    value: unknown;
    paraphrase: string | null;
    confidence: number | null;
  };
  /**
   * Move-on signal (Data Slots feature): this slot has been asked about `attempts` times without a
   * clear answer and is about to be PARKED. The extractor must emit a best-effort, low-confidence
   * fill for it from the WHOLE conversation even if this turn's message barely informs it — the
   * orchestrator then marks that fill provisional and moves on, so the respondent keeps progressing.
   */
  parkPending?: boolean;
  /** How many consecutive turns have already targeted this slot (surfaced when `parkPending`). */
  attempts?: number;
}

/**
 * A normalised data-slot fill intent (Data Slots feature) — the abstraction-layer analogue of
 * {@link AnswerSlotIntent}. `paraphrase` is a short natural-language restatement of the
 * respondent's position toward the slot (shown in the panel); `confidence` is how well the
 * agent believes it understands them. Addressed by `dataSlotKey`; the route resolves it to an
 * `AppDataSlot.id` and upserts a per-session fill.
 */
export interface DataSlotFillIntent {
  dataSlotKey: string;
  value: unknown;
  paraphrase: string;
  confidence: number;
  provenance: AnswerProvenance;
  rationale?: string;
  /**
   * Move-on (Data Slots feature): the orchestrator marks a fill provisional when it parks a slot
   * after the re-ask cap (a best-effort inference, shown "provisional · may revisit"). Set by the
   * orchestrator, never the model. A later confident fill clears it.
   */
  provisional?: boolean;
}

/**
 * A normalised, version-agnostic answer-write intent — the F4.2 analogue of
 * F1.1's `ChangeRecordIntent`. Coherence-checked and type-validated by
 * `normalizeAnswerIntents`; F4.6 resolves `slotKey` → `AppQuestionSlot.id` and
 * persists. Carries no `sessionId`/`answerId` — those belong to the persistence
 * layer that doesn't exist yet.
 */
export interface AnswerSlotIntent {
  /** Resolves to `AppQuestionSlot.id` at persist time (F4.6). */
  slotKey: string;
  /** The slot's REAL type (from the context), never the LLM's self-declared claim. */
  questionType: QuestionType;
  /** The validated, per-type-normalised value (string, number, boolean, string[], …). */
  value: unknown;
  /** Extraction confidence 0–1 — feeds the weighted strategy's low-confidence boost. */
  confidence: number;
  /** How the value was arrived at (F4.2 emits direct | inferred | synthesised). */
  provenance: AnswerProvenance;
  /** Short justification for the value. */
  rationale: string;
  /** `true` when this answers the active question; `false` for a side-effect on another slot. */
  isActiveQuestion: boolean;
  /** The span of the message the value came from — present for `direct`. */
  sourceQuote?: string;
  /**
   * Free-text only: the living, panel-facing paraphrase of the respondent's account (significant
   * verbatim in quotes), persisted to `AppAnswerSlot.paraphrase`. Absent for typed answers.
   */
  paraphrase?: string | null;
}

/** A raw extracted answer dropped by the normaliser, with why — for logging. */
export interface DroppedAnswer {
  slotKey: string;
  reason: string;
}

/**
 * Output of `normalizeAnswerIntents`: the coherent, type-valid intents ready for
 * (eventual) persistence, plus the records removed and why. Mirrors F1.1's
 * `NormalizeChangeRecordsResult` `{ intents, dropped }` shape.
 */
export interface AnswerExtractionResult {
  intents: AnswerSlotIntent[];
  dropped: DroppedAnswer[];
}
