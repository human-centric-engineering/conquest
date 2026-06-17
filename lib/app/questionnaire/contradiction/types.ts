/**
 * Contradiction-detection contract and in-memory shapes (F4.3).
 *
 * Over a long conversation a respondent can give answers that conflict — "no
 * children" early, "my daughter's at college" later. This module owns the pure,
 * DB-free shapes for the pass that *detects* such conflicts and **surfaces them to
 * the agent for confirmation** — it never overwrites an answer. Resolving a
 * contradiction (re-asking, refining, the `refined` provenance) is F4.4's job;
 * persistence + the session/turn machinery is F4.6's.
 *
 * **Pure by design**, exactly as for extraction (F4.2) and selection (F4.1): the
 * session/answer tables don't exist yet, so detection never touches Prisma. A
 * caller (a Vitest harness today, the streaming engine later) assembles an
 * in-memory {@link ContradictionContext} from already-captured answers, and the
 * detector returns version-agnostic {@link ContradictionFinding}s — surfacing
 * intents, not rows.
 */

import type {
  AnswerProvenance,
  ContradictionMode,
  QuestionType,
} from '@/lib/app/questionnaire/types';

/**
 * How serious a detected contradiction is — detector-internal vocabulary, so the
 * tuple lives here in the core (not in the shared `../types.ts`), the same way
 * `EXTRACTOR_EMITTED_PROVENANCES` is a contract-local subset. A `const` tuple so
 * the Zod contract enum and the normaliser's clamp derive from one source.
 */
export const CONTRADICTION_SEVERITIES = ['low', 'medium', 'high'] as const;
export type ContradictionSeverity = (typeof CONTRADICTION_SEVERITIES)[number];

/**
 * A question slot projected into the shape the detector reads. The caller maps
 * `AppQuestionSlot` (+ its section) into this — the detector sees no Prisma rows.
 * Carries the `prompt` and `typeConfig` because judging whether two values truly
 * conflict needs the questions' meaning and their option/scale vocabulary.
 */
export interface ContradictionSlotView {
  /** `AppQuestionSlot.id`. Optional: the pure path addresses slots by `key`; the
   *  route's DB-derived context carries it through so F4.6 can persist without a
   *  second lookup. */
  id?: string;
  /** Stable per-version slug — how findings address a slot (no IDs pre-persist). */
  key: string;
  /** `AppQuestionnaireSection.id` the slot belongs to. Optional, as for `id`. */
  sectionId?: string;
  /** The question type; gives the detector the shape of the value to compare. */
  type: QuestionType;
  /** The slot's stored `typeConfig` (choices, likert bounds, …) or `null`. */
  typeConfig: unknown;
  /** The question prompt — the detector needs it to reason about the conflict. */
  prompt: string;
  /** Author guidance on how to interpret answers; passed to the LLM when present. */
  guidelines?: string;
  /** Whether an answer is mandatory; surfaced to the LLM as priority context. */
  required: boolean;
}

/**
 * One answer already captured this session — the unit the detector compares. Richer
 * than extraction's `ExtractionAnsweredView` (which only records *that* a slot is
 * answered): contradiction reasons over the actual `value`, and `provenance` tells
 * the detector which side of a conflict to trust (a `direct` answer outweighs a
 * `synthesised` one).
 */
export interface AnsweredSlotView {
  /** `ContradictionSlotView.key` this answer belongs to. */
  slotKey: string;
  /** The captured value (string, number, boolean, string[], …) to compare. */
  value: unknown;
  /** Extraction confidence 0–1, or `null` when not scored. */
  confidence: number | null;
  /** How the value was arrived at (F4.2 vocabulary) — inbound metadata only;
   *  detection emits no provenance of its own. */
  provenance?: AnswerProvenance;
  /** Which turn captured the answer, for windowing the comparison (F4.6 seam). */
  turnIndex?: number;
}

/**
 * Everything the detector reads to find contradictions across a session's answers
 * — entirely in-memory.
 */
export interface ContradictionContext {
  /** The version's slot definitions (capped by the caller), indexed by `key`. */
  slots: ContradictionSlotView[];
  /** The answers captured so far that the detector compares against each other. */
  answers: AnsweredSlotView[];
  /** Behaviour on a hit: `off` / `flag` (surface) / `probe` (follow up). Shapes
   *  the prompt (probe requested only under `probe`) and the normaliser output. */
  mode: ContradictionMode;
  /** How many prior answers to compare against; `0` = compare all. Mirrors the
   *  config's `contradictionWindowN`. */
  windowN: number;
  /**
   * The respondent's most recent message, when the caller wants the detector to ALSO
   * weigh it against the captured answers. This is what catches a *same-slot reversal*
   * ("I hate the job" earlier → "I love my job" now): the new statement may not have
   * overwritten the stored answer yet (extraction can miss a re-answer to an already-
   * filled slot), so comparing stored answers against each other alone wouldn't see it.
   * When present, a finding may reference a SINGLE slot — the stored answer the latest
   * message contradicts — since the message itself is the implicit second party (the
   * normaliser relaxes its ≥2-distinct-slots rule accordingly). Absent → the classic
   * answer-vs-answer pass, unchanged.
   */
  currentStatement?: string;
  /** Stable session identity — threaded into cost-log metadata. */
  sessionId: string;
}

/** When detection runs, for the pure {@link DetectionPhase}-aware scheduler. */
export type DetectionPhase = 'turn' | 'completion-sweep';

/**
 * The pure scheduler's decision: whether to run this pass, and how much history to
 * compare. `compareWindow: 'all'` compares every answer; a number compares the
 * most recent N. The engine (F4.6) slices `ContradictionContext.answers` to this
 * before dispatching.
 */
export interface DetectionDecision {
  run: boolean;
  compareWindow: 'all' | number;
}

/**
 * A detected contradiction the agent should surface for confirmation — F4.3's
 * analogue of F4.2's `AnswerSlotIntent`, but a *surfacing* intent: it carries no
 * value to write. F4.6 renders it to the agent/respondent; nothing is overwritten.
 */
export interface ContradictionFinding {
  /** The two-or-more conflicting slots (≥2 distinct, all answered — enforced by
   *  the normaliser). An array so 3-way conflicts are expressible. */
  slotKeys: string[];
  /** Human-readable account of why the answers conflict. */
  explanation: string;
  /** How serious the conflict is. */
  severity: ContradictionSeverity;
  /** The detector's certainty the conflict is real, 0–1. */
  confidence: number;
  /** A single neutral follow-up question that lets the respondent reconcile the
   *  answers — present **only** under `probe` mode; absent for `flag`. */
  suggestedProbe?: string;
}

/**
 * A `probe`-mode contradiction parked across turns (the confirm-before-overwrite flow). When the
 * detector flags a conflict under `probe` mode, nothing is overwritten: the interviewer asks a
 * reconciliation question and this is persisted on the session. The NEXT turn resolves it — the
 * refiner applies the change if the respondent confirms, or keeps the original — and clears it.
 * Persisted as `AppQuestionnaireSession.pendingContradiction` (JSON).
 */
export interface PendingContradiction {
  /** The conflicting question slot key(s) the probe is reconciling. */
  slotKeys: string[];
  /** Why the answers conflict — surfaced informationally (the blue notice), not as the question. */
  explanation: string;
  /** The reconciliation question the interviewer asked (probe-mode finding's probe). */
  suggestedProbe?: string;
  /** The respondent message that triggered the contradiction (the "new" side of the conflict). */
  statement: string;
  /** The zero-based selection round the probe was raised on (for ordering / audit). */
  raisedAtTurnIndex: number;
}

/** A raw detected contradiction dropped by the normaliser, with why — for logging. */
export interface DroppedFinding {
  slotKeys: string[];
  reason: string;
}

/**
 * Output of `normalizeContradictionFindings`: the coherent findings ready to
 * surface, plus the records removed and why. Mirrors F4.2's `{ intents, dropped }`.
 */
export interface ContradictionDetectionResult {
  findings: ContradictionFinding[];
  dropped: DroppedFinding[];
}

/**
 * A counts-only roll-up of a detection pass — the shape the preview route returns
 * as its `summary` and the capability's PII-safe `redactProvenance` preview embeds.
 * Carries no values/explanations/probes, so it's safe to surface anywhere. Built by
 * `summarizeFindings` so those two call sites can't drift apart.
 */
export interface FindingsSummary {
  findingCount: number;
  probeCount: number;
  droppedCount: number;
  severityCounts: Record<string, number>;
}
