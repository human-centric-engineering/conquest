/**
 * Per-flow rate limiters for the live respondent-session routes (F6.1).
 *
 * The routes inherit the platform's 100/min `api` section cap (applied by `proxy.ts`).
 * These are the tighter in-handler sub-caps the section policy expects an expensive or
 * abusable sub-flow to add. We do NOT call the section limiters here — the middleware
 * already did; a dedicated limiter keeps each flow's window independent.
 */

import { createRateLimiter } from '@/lib/security/rate-limit';

/**
 * Session-start sub-cap. Creating a session is a cheap write, but it's a respondent-facing
 * mutation that mints a session row (and, for the no-login path in PR5, a public surface),
 * so it gets a modest per-key cap above the section default. Keyed on the respondent user
 * id (authenticated paths) or the client IP (the no-login path, PR5).
 */
export const SESSION_START_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link sessionStartLimiter}, in milliseconds. */
export const SESSION_START_RATE_LIMIT_INTERVAL_MS = 60_000;

export const sessionStartLimiter = createRateLimiter({
  interval: SESSION_START_RATE_LIMIT_INTERVAL_MS,
  maxRequests: SESSION_START_RATE_LIMIT_MAX,
});

/**
 * Per-turn sub-cap. Each turn spends up to several LLM calls (extraction, detection,
 * refinement, offer phrasing) — real per-turn cost, the same order as the F4.2–F4.5
 * preview sub-caps (60/min). Keyed on the respondent user id (authenticated paths) or the
 * client IP (the no-login path, PR5), who owns the session spend.
 */
export const TURN_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link turnLimiter}, in milliseconds. */
export const TURN_RATE_LIMIT_INTERVAL_MS = 60_000;

export const turnLimiter = createRateLimiter({
  interval: TURN_RATE_LIMIT_INTERVAL_MS,
  maxRequests: TURN_RATE_LIMIT_MAX,
});

/**
 * Turn-evaluation sub-cap. The evaluate-turn route runs one reasoning-model completion over a
 * turn dump — paid LLM work, like the design-evaluation preview. It's an admin-only,
 * preview-only action an admin clicks per turn, so 20/min is ample while bounding a hammered
 * "Evaluate" button. Keyed on the admin user id, who owns the spend.
 */
export const TURN_EVALUATION_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link turnEvaluationLimiter}, in milliseconds. */
export const TURN_EVALUATION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const turnEvaluationLimiter = createRateLimiter({
  interval: TURN_EVALUATION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: TURN_EVALUATION_RATE_LIMIT_MAX,
});
