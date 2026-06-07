/**
 * Per-turn orchestrator contract and in-memory shapes (F6.1).
 *
 * The orchestrator is the deterministic pipeline that wraps the P4 capabilities for one
 * respondent turn: extract the answer (F4.2) → detect contradictions (F4.3) → refine
 * (F4.4) → assess completion (F4.5, pure) → respond (offer or next question, F4.1/F4.5).
 * Unlike Sunrise's `streamChat` (an LLM-driven tool loop), the order here is fixed and
 * the LLM is called *inside* each capability.
 *
 * **Pure by design**, like F4.1–F4.5. {@link runTurn} reads a caller-assembled
 * {@link TurnState} and returns a {@link TurnResult} — no Prisma, no Next, no clock, no
 * direct LLM. The impure work is injected as {@link CapabilityInvokers} (wired to the
 * real capabilities at the route seam in PR4; stubbed in unit tests). The feature flags
 * are resolved by the route (async DB reads) and passed in as {@link TurnFlags}, so the
 * core stays synchronous in its branching. The offer *prose* is intentionally NOT
 * produced here — for an offer turn the core returns the composer input and the route
 * streams the tokens (the user-chosen real-token-streaming path); the core only decides
 * *whether* to offer.
 */

import type { ChatEvent } from '@/types/orchestration';
import type { AnswerProvenance } from '@/lib/app/questionnaire/types';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';
import type {
  AnsweredView,
  QuestionView,
  SelectionDecision,
} from '@/lib/app/questionnaire/selection/types';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { ContradictionFinding } from '@/lib/app/questionnaire/contradiction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';

/**
 * One existing answer's full value, as the refiner reads it. Richer than the
 * coverage-only {@link AnsweredView} (which carries just questionId + confidence): the
 * refiner needs the value/provenance to decide refine vs overwrite vs leave.
 */
export interface ExistingAnswerView {
  slotKey: string;
  value: unknown;
  provenance: AnswerProvenance;
  confidence?: number;
  rationale?: string;
  turnIndex?: number;
}

/**
 * Which optional sub-features are enabled for this turn — resolved by the route from the
 * `feature_flag` rows (async) and passed in so the core's branching stays pure/sync.
 * Gating is **per-step**: a disabled step is skipped gracefully and the turn continues
 * with whatever is on (not a whole-turn 404). Adaptive selection degrades inside the
 * `selectNext` invoker, so it isn't a flag here.
 */
export interface TurnFlags {
  /** F4.2 answer extraction. */
  extraction: boolean;
  /** F4.3 contradiction detection (also gated by `config.contradictionMode`). */
  contradiction: boolean;
  /** F4.4 answer refinement. */
  refinement: boolean;
  /** F4.5 completion-offer phrasing (the deterministic gate is always free). */
  completion: boolean;
}

/** One base64-encoded attachment on a turn (mirrors the platform `chatAttachmentSchema`). */
export interface TurnAttachment {
  name: string;
  mediaType: string;
  data: string;
}

/**
 * Everything {@link runTurn} reads for one turn — assembled once by the route's context
 * loader (PR3) from the session's real answer + turn rows. The union of the P4 context
 * DTOs: selection/completion read `questions`/`answered`/`config`; extraction reads
 * `userMessage`/`recentMessages`; refinement reads `existingAnswers`.
 */
export interface TurnState {
  /** The session this turn belongs to. */
  sessionId: string;
  /** The respondent's message; `''` for the opening turn (no extraction/detect/refine). */
  userMessage: string;
  /** The version's resolved config (defaults when no row was ever saved). */
  config: QuestionnaireConfigShape;
  /** Every question slot in the version. `prompt` must be populated for the live path. */
  questions: QuestionView[];
  /** Distinct questions answered before this turn (coverage view). */
  answered: AnsweredView[];
  /** Full values of the answers captured so far (refiner view). */
  existingAnswers: ExistingAnswerView[];
  /** Recent transcript, oldest → newest (extraction / adaptive / offer phrasing read it). */
  recentMessages: string[];
  /**
   * Files attached to this turn's message (images / documents), base64-encoded. The
   * extraction invoker forwards them so the extractor reads them alongside the text.
   * Absent on the opening turn and text-only turns. Shape mirrors `chatAttachmentSchema`.
   */
  attachments?: TurnAttachment[];
  /** Zero-based selection round — the number of prior question picks. */
  selectionRound: number;
  /** Which sub-features are enabled this turn. */
  flags: TurnFlags;
  /**
   * Cost-cap pressure for this turn, set by the route when the session's spend so far crosses
   * the soft threshold (F6.3). `'soft'` biases the core toward offering completion early (so the
   * session winds down before the hard cap) and threads a wrap-up instruction into the offer
   * prose. Absent (the default) means no cost pressure. The hard cap never reaches the core — the
   * route refuses that turn with a 402 before `runTurn`.
   */
  costPressure?: 'soft';
}

/** One capability outcome recorded on a turn (ordered by dispatch). Re-exported by the
 *  turn-persistence seam (`_lib/turns.ts`) so the pure core owns the shape. */
export interface ToolCallRecord {
  /** The capability slug dispatched (or a synthetic id for the selection step). */
  slug: string;
  /** Whether the step succeeded (a fail-soft empty result counts as a failure). */
  success: boolean;
  /** Diagnostic code when `success` is false. */
  code?: string;
  /** Wall-clock dispatch latency in ms, when the (impure) invoker measured it. */
  latencyMs?: number;
}

/** Extraction invoker outcome — fail-soft: `diagnostic` set instead of throwing. */
export interface ExtractOutcome {
  intents: AnswerSlotIntent[];
  costUsd: number;
  latencyMs?: number;
  diagnostic?: string;
}

/** Contradiction-detection invoker outcome. */
export interface DetectOutcome {
  findings: ContradictionFinding[];
  costUsd: number;
  latencyMs?: number;
  diagnostic?: string;
}

/** Refinement invoker outcome. */
export interface RefineOutcome {
  decisions: RefinementDecision[];
  costUsd: number;
  latencyMs?: number;
  diagnostic?: string;
}

/** Selection invoker outcome — wraps the pure {@link SelectionDecision} with latency. */
export interface SelectOutcome {
  decision: SelectionDecision;
  latencyMs?: number;
}

/** What triggered a refinement pass (passed to the refine invoker). */
export interface RefinementTrigger {
  /** The contradiction that prompted reconciliation, if any. */
  contradiction?: ContradictionFinding;
}

/**
 * The impure boundary, injected. Each invoker receives the (effective) turn state and
 * returns its capability's result fail-soft (never throws — a failure sets `diagnostic`
 * and returns an empty result). The real versions dispatch the seeded capabilities at the
 * route seam (PR4); unit tests pass stubs. `composeOffer` is deliberately absent — the
 * offer prose is streamed by the route, not produced in the pure core.
 */
export interface CapabilityInvokers {
  extractAnswers(state: TurnState): Promise<ExtractOutcome>;
  detectContradictions(state: TurnState): Promise<DetectOutcome>;
  refineAnswer(state: TurnState, trigger: RefinementTrigger): Promise<RefineOutcome>;
  selectNext(state: TurnState): Promise<SelectOutcome>;
}

/**
 * The composer input the route's streaming offer composer needs — mirrors
 * `ComposeCompletionOfferArgs` minus `sessionId` (the route adds it). Returned (not
 * rendered) by the core so the route can stream the tokens.
 */
export interface OfferComposeInput {
  coverage: number;
  answeredCount: number;
  capReached: boolean;
  coveredSlots: Array<{ key: string; prompt: string }>;
  remainingSlots: Array<{ key: string; prompt: string }>;
  recentMessages: string[];
  /**
   * Set when the session is at the soft cost cap (F6.3): the composer adds a brief "we're near
   * this session's limit, keep it short and wrap up" instruction to its system prompt. Distinct
   * from {@link capReached} (the F4.5 question-count cap) — this is the USD budget.
   */
  costWrapUp?: boolean;
}

/**
 * The agent's response for the turn. `question` carries the deterministic prompt text;
 * `offer` carries the composer input (the route streams the prose); `complete`/`none`
 * carry a deterministic terminal message.
 */
export type TurnResponse =
  | { kind: 'question'; questionId: string; text: string }
  | { kind: 'offer'; input: OfferComposeInput }
  | { kind: 'complete'; text: string }
  | { kind: 'none'; text: string };

/**
 * The result of one turn — what the route persists (side effects + turn record) and
 * streams (events + response). The core assembles everything; the route does the I/O.
 */
export interface TurnResult {
  /** What to say back this turn (route renders/streams it). */
  response: TurnResponse;
  /** `AppQuestionSlot.id` asked for, or `null` for an offer/completion/none turn. */
  targetedQuestionId: string | null;
  /** The answer writes this turn produced — the route persists them at the slot seam. */
  sideEffects: {
    answerUpserts: AnswerSlotIntent[];
    answerRefinements: RefinementDecision[];
  };
  /** Side-band frames to stream (warnings/status) — NOT the main content. */
  events: ChatEvent[];
  /** Ordered capability outcomes, for the turn record. */
  toolCalls: ToolCallRecord[];
  /** Summed per-turn LLM spend across the invokers that ran. */
  costUsd: number;
  /** Contradictions surfaced this turn (for the route / turn record). */
  contradictions: ContradictionFinding[];
  /** The deterministic completion assessment computed this turn. */
  assessment: CompletionAssessment;
}
