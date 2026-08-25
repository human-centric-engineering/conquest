/**
 * Conditional Topics constants (P17).
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

/* -------------------------------------------------------------------------- */
/* The opening probe classifier (G03 / F17.17)                                */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on the routability check.
 *
 * Half the planner's, and for a sharper reason: this call sits INSIDE a live turn, between the
 * respondent's message and the interviewer's reply, whereas the planner runs after a turn is
 * persisted. The whole point of the check is to save the respondent a question — spending twelve
 * seconds of their time to do it would be self-defeating.
 */
export const OPENING_PROBE_TIMEOUT_MS = 6_000;

/** Output cap. One verdict and a sentence — never prose. */
export const OPENING_PROBE_MAX_TOKENS = 300;

/** How many conditional topics' criteria to inline. Beyond this the check stops paying for itself. */
export const MAX_CANDIDATES_IN_PROBE_PROMPT = 20;

/** Per-item character cap on the evidence lines the check reads. */
export const PROBE_EVIDENCE_CHARS = 600;

/** How many pieces of opening evidence to inline. */
export const MAX_EVIDENCE_IN_PROBE_PROMPT = 20;

/* -------------------------------------------------------------------------- */
/* The Routing Analyst's document budget (F17.29)                             */
/* -------------------------------------------------------------------------- */

/**
 * Total characters of SUPPLEMENTARY document text the analyst prompt may carry.
 *
 * The primary document is deliberately NOT bounded here: it is what every run before this one
 * carried in full, and shrinking it would change the answer on versions nobody touched. The
 * companions an admin attaches are new spend, so they get the budget — shared across all of them,
 * oldest attachment first, because the earlier attachment is the one the admin has already seen the
 * analyst act on.
 */
export const MAX_SUPPLEMENTARY_DOCUMENT_CHARS = 40_000;

/** Marks where a supplementary document was cut, so the analyst never quotes across the seam. */
export const SUPPLEMENTARY_TRUNCATION_MARKER = '\n\n[… document truncated to fit the budget …]';

/* -------------------------------------------------------------------------- */
/* Partial topic selection — what the planner is shown (C6 / F17.29)          */
/* -------------------------------------------------------------------------- */

/**
 * How many of a topic's questions the planner prompt lists, per topic.
 *
 * A topic whose items are not listed cannot be partially selected — the prompt says so, so the
 * planner chooses it whole rather than guessing at keys it was never shown.
 */
export const MAX_PLANNER_ITEMS_PER_TOPIC = 12;

/** Characters of one question's wording. Enough to recognise it; not enough to re-read it. */
export const MAX_PLANNER_ITEM_CHARS = 90;

/**
 * Items listed across ALL candidates, spent best-first.
 *
 * The whole-prompt bound. Without it a forty-topic instrument would spend more of the planner's
 * context on question wording than on what the respondent actually said — which is the evidence
 * the decision rests on.
 */
export const MAX_PLANNER_RENDERED_ITEMS = 120;
