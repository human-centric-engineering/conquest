/**
 * Experience agent slugs and runtime constants.
 *
 * Slugs match the seeded `AiAgent` rows (`prisma/seeds/app-questionnaire/`). Kept beside the rest
 * of the experience module rather than in the shared `questionnaire/constants.ts` so the whole
 * feature stays removable in one directory.
 */

/**
 * The routing selector — decides `conclude` vs `route` at a fork.
 *
 * Wants a reasoning-tier model: it weighs a digest against several candidates' criteria. But the
 * respondent is WAITING on this call, so the seed pairs a capable model with a short timeout and
 * a deterministic fallback rather than reaching for the largest available.
 */
export const EXPERIENCE_ROUTER_AGENT_SLUG = 'app-experience-router';

/**
 * The handoff briefing agent — compresses carry-over into a short briefing plus the bridging
 * line that opens the next leg.
 *
 * Also runs while the respondent waits, so it is bounded the same way. Optional: when it fails,
 * the next leg still receives the deterministic data-slot digest.
 */
export const EXPERIENCE_HANDOFF_AGENT_SLUG = 'app-experience-handoff';

/** Cap on the briefing the handoff agent produces, in words (enforced by prompt + slice). */
export const HANDOFF_BRIEFING_MAX_WORDS = 250;

/** Character cap on the persisted briefing — the backstop for a model that ignores the word cap. */
export const HANDOFF_BRIEFING_MAX_CHARS = 2_000;

/** Character cap on the bridging line that becomes the next leg's first assistant turn. */
export const HANDOFF_OPENING_LINE_MAX_CHARS = 500;

/**
 * How long a respondent's client polls the run-status endpoint before giving up and showing a
 * "check back shortly" state.
 *
 * Generous relative to the selector's 12s timeout: the poll also covers leg-B session creation and
 * the handoff briefing, and a client that gives up while the server is still working would show a
 * failure that is not one.
 */
export const RUN_POLL_TIMEOUT_MS = 45_000;

/** Interval between run-status polls. */
export const RUN_POLL_INTERVAL_MS = 1_500;
