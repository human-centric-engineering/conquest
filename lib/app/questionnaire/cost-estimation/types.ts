/**
 * Pre-launch cost-estimation types and heuristic constants (F3.3).
 *
 * The conversational session/turn engine (P4/P6) does not exist yet, so there are
 * **no real session runs** to calibrate against. This estimator is therefore
 * **heuristic by necessity** — `basedOn` is always `'heuristic'`. When P6 starts
 * logging per-turn token actuals, a future PR can add an empirical mode keyed on
 * those (see `.context/app/questionnaire/cost-estimation.md`).
 *
 * The constants below model one respondent's session as a sequence of "turns",
 * one per asked question. The dominant cost driver is the **conversation history**:
 * every turn re-sends the accumulated transcript, so input tokens grow quadratically
 * with the number of questions asked. The constants are deliberately conservative
 * and tunable; they are not measured values.
 */

/** Fixed system-prompt tokens re-sent on every turn (agent instructions). */
export const SYSTEM_PROMPT_TOKENS = 1500;

/**
 * Tokens each prior turn (one Q + its answer) contributes to a later turn's
 * input when the transcript is replayed. Turn `i` (0-indexed) carries `i` of these.
 */
export const HISTORY_TOKENS_PER_PRIOR_TURN = 250;

/** Output tokens per turn — the agent's reply plus the structured answer extraction. */
export const OUTPUT_TOKENS_PER_TURN = 400;

/** Range factors applied to the mid estimate to express heuristic uncertainty. */
export const RANGE_LOW_FACTOR = 0.5;
export const RANGE_HIGH_FACTOR = 1.7;

/** A low / mid / high USD band for a single dimension of the estimate. */
export interface CostRange {
  lowUsd: number;
  midUsd: number;
  highUsd: number;
}

/** The numeric inputs and intermediate figures the estimate was derived from. */
export interface CostEstimateAssumptions {
  /** Total question slots in the version. */
  questionCount: number;
  /** Questions actually asked per session after applying the cap/floor. */
  effectiveQuestionsPerSession: number;
  /** Heuristic input tokens for one session. */
  inputTokensPerSession: number;
  /** Heuristic output tokens for one session. */
  outputTokensPerSession: number;
  /** Resolved per-million input price, or `null` when the model has no known price. */
  inputCostPerMillion: number | null;
  /** Resolved per-million output price, or `null` when the model has no known price. */
  outputCostPerMillion: number | null;
}

/** The full pre-launch cost estimate for a questionnaire version. */
export interface SessionCostEstimate {
  /** Estimated USD to run one respondent through the questionnaire. */
  perSession: CostRange;
  /** Estimated USD across `respondents` sessions (`perSession × respondents`). */
  perQuestionnaire: CostRange;
  /** Respondent count the per-questionnaire figure is scaled to (≥ 1). */
  respondents: number;
  /** Always `'heuristic'` until P6 supplies empirical session data. */
  basedOn: 'heuristic';
  /**
   * `false` when the resolved model has no registry price — USD fields are `0`
   * and must not be shown as a real figure (the UI says "pricing not configured").
   */
  pricingKnown: boolean;
  /** The model slug pricing was resolved against (provider-agnostic). */
  model: string;
  assumptions: CostEstimateAssumptions;
  /** Human-readable explanation of the basis and any caveats. */
  notes: string;
}
