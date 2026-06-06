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
