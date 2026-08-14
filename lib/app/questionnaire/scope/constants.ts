/**
 * Adaptive Scope constants (P17).
 *
 * Kept out of `types.ts` so that module stays a pure leaf importable from client components — this
 * one names a runtime agent, which only the server cares about.
 */

/** The agent that decides which conditional topics an interview should cover. */
export const SCOPE_PLANNER_AGENT_SLUG = 'app-scope-planner';

/**
 * Hard ceiling on the planner call.
 *
 * Short on purpose, for exactly the reason `selectNextStep` is: the respondent has just finished
 * the opening and is waiting. A deterministic fallback plan delivered in 12 seconds is a better
 * experience than a perfect one delivered in 60.
 */
export const SCOPE_PLANNER_TIMEOUT_MS = 12_000;

/** Output cap. One decision object, not prose — reasoning models split this with their own reasoning. */
export const SCOPE_PLANNER_MAX_TOKENS = 1_500;

/** How many opening data-slot fills to inline. Beyond this the prompt stops paying for itself. */
export const MAX_FILLS_IN_PLANNER_PROMPT = 40;

/** Per-fill character cap in the prompt. */
export const PLANNER_FILL_CHARS = 600;

/**
 * How many answered questions to inline, in the respondent's own words.
 *
 * Smaller than the fill budget on purpose: an answer carries its question with it, so each entry
 * costs roughly twice a fill, and the ones that matter are the opening's — which the caller orders
 * first for exactly this reason.
 */
export const MAX_ANSWERS_IN_PLANNER_PROMPT = 20;

/** Per-answer character cap in the prompt. */
export const PLANNER_ANSWER_CHARS = 800;
