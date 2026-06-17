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
import type { AnswerProvenance, SensitivitySeverity } from '@/lib/app/questionnaire/types';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';
import type {
  SensitivityAssessment,
  SensitivityOutcome,
} from '@/lib/app/questionnaire/sensitivity/types';
import type {
  AnsweredView,
  QuestionView,
  SelectionDecision,
} from '@/lib/app/questionnaire/selection/types';
import type {
  AnswerSlotIntent,
  DataSlotFillIntent,
} from '@/lib/app/questionnaire/extraction/types';
import type { ContradictionFinding } from '@/lib/app/questionnaire/contradiction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';
import type { SeriousnessVerdict } from '@/lib/app/questionnaire/seriousness/types';

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
  /**
   * Seriousness / abuse gate (platform sub-flag). When on AND `config.abuseThreshold > 0`,
   * a turn the extractor flags as suspicious is judged; a non-serious verdict is disregarded,
   * strikes the session, and (at the threshold) abandons it.
   */
  seriousnessGate: boolean;
  /**
   * Sensitivity awareness / safeguarding (platform sub-flag AND per-questionnaire toggle). When on,
   * the extractor emits a `sensitivity` assessment; the core remembers it (running-max level +
   * notes), softens later phrasing, and signposts support once on a serious disclosure.
   */
  sensitivityAwareness: boolean;
}

/** One base64-encoded attachment on a turn (mirrors the platform `chatAttachmentSchema`). */
export interface TurnAttachment {
  name: string;
  mediaType: string;
  data: string;
}

/**
 * A data slot the conversation targets (Data Slots feature). Loaded by the route, ordered for
 * topic-local targeting (grouped by theme). `name`/`description` feed the interviewer phraser.
 */
export interface DataSlotTarget {
  /** `AppDataSlot.id`. */
  id: string;
  /** Stable per-version slug — how fills address it. */
  key: string;
  name: string;
  description: string;
  theme: string;
  ordinal: number;
  weight: number;
  /**
   * Keys of the question slots this data slot "meaningfully captures" (the `AppDataSlotQuestion`
   * M:N mapping). Filling the slot in conversation lets the extractor ALSO answer these mapped
   * questions (the forward propagation the schema documents) — threaded into the extractor so a
   * captured position flows onto the underlying form questions, not just the panel. The turn-context
   * loader always sets it (possibly `[]`); optional so pure targeting tests can omit it — targeting
   * itself never reads the mapping (mirrors {@link DataSlotAnsweredView}'s optional value fields).
   */
  mappedQuestionKeys?: string[];
}

/** One data slot already filled this session (targeting view — filled at confidence ≥ θ). */
export interface DataSlotAnsweredView {
  /** `DataSlotTarget.id`. */
  dataSlotId: string;
  confidence: number | null;
  /**
   * The fill's captured position + restatement, when loaded. Threaded into the extractor (as a
   * data-slot candidate's `current`) so it can UPDATE/CORRECT the slot rather than re-deriving it.
   * Targeting itself only reads `confidence`; these are optional so pure targeting tests can omit
   * them.
   */
  value?: unknown;
  paraphrase?: string | null;
  /**
   * The fill's provenance, when loaded. A `direct` fill — a position the respondent plainly
   * STATED — counts as "covered" regardless of the confidence NUMBER (a stated answer is answered),
   * so a clear answer the extractor under-scored is never treated as missing, re-asked, or parked.
   * Absent in pure targeting tests, which exercise the confidence-only path.
   */
  provenance?: AnswerProvenance;
  /**
   * Move-on (Data Slots feature): true when this fill is a best-effort inference recorded after the
   * re-ask cap. A provisional slot counts as "covered" for targeting (so it isn't re-asked) but at
   * low confidence; a later confident fill clears it. Absent in pure targeting tests.
   */
  provisional?: boolean;
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
  /**
   * Seriousness / abuse gate: the session's strike count BEFORE this turn (flagged non-genuine
   * answers so far). The route loads it from `AppQuestionnaireSession.abuseStrikes`; the core
   * folds a new strike in and returns the updated count for the route to persist.
   */
  abuseStrikes: number;
  /**
   * Sensitivity awareness / safeguarding: the session's remembered disclosures BEFORE this turn,
   * loaded by the route from `AppQuestionnaireSession`. `sensitivityLevel` is the running-max
   * severity (null until first detection); `sensitivityNotes` are the careful summaries, threaded
   * into the phraser so EVERY later question stays gentle (not just the disclosure turn). Absent
   * when the feature is off.
   */
  sensitivityLevel?: SensitivitySeverity | null;
  sensitivityNotes?: string[];
  /** Which sub-features are enabled this turn. */
  flags: TurnFlags;
  /**
   * Data Slots feature: present in data-slot mode. `dataSlots` is the version's data slots
   * (theme-ordered for topic-local targeting); `dataSlotAnswered` is the filled set; the
   * `activeDataSlotKey` is the slot the previous turn targeted (for re-ask/transition framing).
   * Absent (the default) means question mode — `runDataSlotTurn` is not used.
   */
  dataSlots?: DataSlotTarget[];
  dataSlotAnswered?: DataSlotAnsweredView[];
  activeDataSlotKey?: string | null;
  /**
   * Move-on (Data Slots feature): consecutive re-ask count per data-slot id (turns that targeted
   * the slot without a confident fill). Only the most-recently targeted slot carries a non-zero
   * count. When it reaches `config.maxDataSlotAttempts` and the slot is still unfilled, the
   * orchestrator parks it (records a provisional fill, moves on). Absent in question mode.
   */
  dataSlotAttempts?: Record<string, number>;
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
  /** Data Slots feature: fills captured this turn (present only in data-slot mode). */
  dataSlotFills?: DataSlotFillIntent[];
  /**
   * Seriousness gate — stage 1 ("the main agent suspects"): the extractor flags an answer that
   * reads as possibly non-genuine (preposterous / abusive / off-topic), so the orchestrator only
   * pays for the dedicated judge when it's worth a second look. Absent/`false` = no suspicion.
   */
  suspectedNonGenuine?: boolean;
  /** A short reason the extractor was suspicious (for logs/trace). */
  suspicionReason?: string;
  /**
   * Sensitivity awareness: the extractor's assessment of a sensitive/contentious disclosure this
   * turn, when one was detected (and the feature is on). Absent = nothing detected.
   */
  sensitivity?: SensitivityAssessment;
  costUsd: number;
  latencyMs?: number;
  diagnostic?: string;
}

/** Seriousness-judge invoker outcome — stage 2. `verdict: null` on a fail-soft diagnostic. */
export interface SeriousnessOutcome {
  verdict: SeriousnessVerdict | null;
  costUsd: number;
  latencyMs?: number;
  diagnostic?: string;
}

/**
 * Dedicated sensitivity-detector invoker outcome. `assessment: null` means nothing was detected
 * (or a fail-soft diagnostic — the orchestrator still merges the extractor field + keyword net, so a
 * detector failure never drops a disclosure the other signals caught).
 */
export interface SensitivityDetectOutcome {
  assessment: SensitivityAssessment | null;
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

/** Adaptive data-slot selection outcome — the chosen slot key + a short rationale + its spend. */
export interface DataSlotSelectOutcome {
  /** `DataSlotTarget.key` of the chosen next slot — guaranteed to be one of the passed `unfilled`. */
  dataSlotKey: string;
  rationale: string;
  costUsd: number;
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
  /**
   * Adaptive data-slot selection (Data Slots feature, 50+-slot scale). Given the unfilled slots,
   * rank them by similarity to the conversation and let an LLM pick the next one to pursue,
   * preserving the theme-local rhythm via `context`. Optional + fail-soft: returns `null` when the
   * sub-feature is off, fewer than 2 candidates remain, the slots aren't embedded, or anything
   * errors — the core then falls back to the deterministic topic-local `pickNextDataSlot`.
   * Implemented at the route seam (embeddings + the seeded selector agent).
   */
  selectDataSlot?(
    state: TurnState,
    unfilled: DataSlotTarget[],
    context: { activeTheme: string | null; parkedTheme: string | null }
  ): Promise<DataSlotSelectOutcome | null>;
  /**
   * Seriousness gate — stage 2: rule on whether this turn's answer is a genuine attempt. The
   * invoker resolves the active question + transcript from its own closure; the core just gates
   * the call and acts on the verdict. Fail-soft (returns `verdict: null` + a diagnostic).
   */
  assessSeriousness(state: TurnState): Promise<SeriousnessOutcome>;
  /**
   * Sensitivity / safeguarding — dedicated detector: rule on whether this turn's message carries a
   * genuine sensitive disclosure. Runs every answered turn while the feature is on, independently of
   * the answer-extractor's (unreliable) `sensitivity` field. The orchestrator merges this with the
   * extractor field and a deterministic keyword net. Fail-soft (returns `assessment: null` + a
   * diagnostic).
   */
  detectSensitivity(state: TurnState): Promise<SensitivityDetectOutcome>;
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
  | {
      /**
       * Data Slots feature: target a data slot conversationally. The route streams the
       * interviewer phrasing of `name` + `description`. `isReask` = this turn re-targeted the
       * slot the previous turn asked (its fill wasn't captured); `isTransition` = we just moved
       * to a new theme/area (the phraser bridges with a natural segue vs deepening in-area).
       */
      kind: 'data_slot';
      dataSlotId: string;
      dataSlotKey: string;
      name: string;
      description: string;
      theme: string;
      isReask: boolean;
      isTransition: boolean;
    }
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
  /**
   * Why the next question/data-slot was chosen this turn — the selector's `rationale`, lifted onto
   * the result so the route can surface it in the "watch it think" reasoning trace (the rationale is
   * otherwise consumed and dropped). Absent on an offer/complete/none turn (nothing was selected).
   * Respondent-safe by construction (a flow rationale, not internal scoring) — see
   * `lib/app/questionnaire/reasoning`.
   */
  selectionRationale?: string;
  /** The strategy that made the selection (lets the reasoning trace phrase the "why" per strategy). */
  selectionStrategy?: import('@/lib/app/questionnaire/types').SelectionStrategy;
  /** The answer writes this turn produced — the route persists them at the slot seam. */
  sideEffects: {
    answerUpserts: AnswerSlotIntent[];
    answerRefinements: RefinementDecision[];
    /** Data Slots feature: the data-slot fills to upsert (present only in data-slot mode). */
    dataSlotFills?: DataSlotFillIntent[];
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
  /**
   * Seriousness / abuse gate outcome for this turn, present only when an answer was flagged
   * non-genuine. The route persists `newStrikeCount` to the session and, when `abandon`, ends
   * the session (status → `abandoned`, reason `abuse_threshold_exceeded`) + streams a terminal
   * frame. Absent on a normal (serious / un-gated) turn.
   */
  abuse?: {
    flagged: boolean;
    newStrikeCount: number;
    abandon: boolean;
    /** The judge's short reason — recorded in the abandonment metadata. */
    reason: string;
  };
  /**
   * Sensitivity awareness / safeguarding outcome, present only when a disclosure was detected this
   * turn. The route appends a note (`{ ...summary, turnOrdinal, createdAt }`), persists `newLevel`
   * on the session, and writes a `sensitivity_flagged` event ({ severity, category } only — never
   * the summary). The support signpost (when `signpost`) is already streamed by the core as a
   * side-band `support` event.
   */
  sensitivity?: SensitivityOutcome;
}
