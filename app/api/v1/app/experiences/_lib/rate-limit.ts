/**
 * Experience-specific rate-limit sub-caps.
 *
 * The section cap (100/min, keyed on session-user) is already applied by `proxy.ts`; these are the
 * per-flow sub-caps for the two experience endpoints where that is not enough.
 */

import { createRateLimiter } from '@/lib/security/rate-limit';

/**
 * Starting a run.
 *
 * Tighter than `sessionStartLimiter` (20/min) because starting a run mints BOTH a run row and a
 * session row, and on a public experience the endpoint is reachable with no credential at all —
 * so it is the most abusable surface the feature adds. Keyed on the respondent user id where there
 * is one, the client IP otherwise.
 */
export const EXPERIENCE_START_RATE_LIMIT_MAX = 10;
export const EXPERIENCE_START_RATE_LIMIT_INTERVAL_MS = 60_000;

export const experienceStartLimiter = createRateLimiter({
  interval: EXPERIENCE_START_RATE_LIMIT_INTERVAL_MS,
  maxRequests: EXPERIENCE_START_RATE_LIMIT_MAX,
});

/**
 * Polling a run's status.
 *
 * Deliberately GENEROUS: the respondent client polls every 1.5s for up to 45s while the selector
 * resolves, which is ~30 requests per handoff before any retry or refresh. A cap tuned for
 * ordinary reads would throttle the happy path. The endpoint is cheap by construction (two indexed
 * reads, no LLM, no writes), so the cap exists to stop a runaway client, not to ration normal use.
 */
export const RUN_POLL_RATE_LIMIT_MAX = 120;
export const RUN_POLL_RATE_LIMIT_INTERVAL_MS = 60_000;

export const runPollLimiter = createRateLimiter({
  interval: RUN_POLL_RATE_LIMIT_INTERVAL_MS,
  maxRequests: RUN_POLL_RATE_LIMIT_MAX,
});
