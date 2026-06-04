/**
 * Per-flow rate limiter for questionnaire ingestion (F1.1 / PR4, T1.4.4).
 *
 * The route already inherits the platform's 100/min `api` section cap (applied
 * by `proxy.ts` keyed on the session user — see `.context/security/rate-limiting.md`).
 * This is the tighter *sub-cap* the section policy expects an expensive sub-flow
 * to add in-handler: each ingest performs ≥1 reasoning-model LLM call plus a
 * document parse and a multi-row transaction, so it's far costlier than a typical
 * request. We cap it at 10/min keyed on the **admin user id** (not the client IP):
 * the cost and the budget both attach to the admin who triggered the extraction,
 * and an admin behind a shared NAT shouldn't throttle their colleagues.
 *
 * The `uploadLimiter` (avatar upload) is the in-handler precedent. We deliberately
 * do NOT call the section limiters (`adminLimiter`, `apiLimiter`) here — the
 * middleware already did. Defining a dedicated limiter instance keeps this flow's
 * window independent of those shared caps.
 */

import { createRateLimiter } from '@/lib/security/rate-limit';

/** Ingestion attempts allowed per admin per minute. */
export const INGEST_RATE_LIMIT_MAX = 10;

/** Sliding-window length for {@link ingestLimiter}, in milliseconds. */
export const INGEST_RATE_LIMIT_INTERVAL_MS = 60_000;

/**
 * Module-level singleton limiter for the ingestion route. Keyed on the admin
 * user id at the call site. Matches the `uploadLimiter` shape.
 */
export const ingestLimiter = createRateLimiter({
  interval: INGEST_RATE_LIMIT_INTERVAL_MS,
  maxRequests: INGEST_RATE_LIMIT_MAX,
});

/**
 * Adaptive next-question preview sub-cap (F4.1). Only the **adaptive** path is
 * limited here: it embeds the latest message and runs an LLM pick, so each call
 * costs an embedding + a completion — far more than the deterministic strategies
 * (which inherit only the section 100/min). Keyed on the admin user id, who owns
 * the spend. The deterministic strategies skip this limiter entirely.
 */
export const ADAPTIVE_SELECTION_RATE_LIMIT_MAX = 30;

/** Sliding-window length for {@link adaptiveSelectionLimiter}, in milliseconds. */
export const ADAPTIVE_SELECTION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const adaptiveSelectionLimiter = createRateLimiter({
  interval: ADAPTIVE_SELECTION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: ADAPTIVE_SELECTION_RATE_LIMIT_MAX,
});

/**
 * Slot-embedding backfill sub-cap (F4.1). One call embeds every (un-embedded)
 * slot in a version — a batch of embedding API calls. Capped tightly per admin
 * so a hammered "regenerate embeddings" button can't run up the embedding bill.
 */
export const EMBED_SLOTS_RATE_LIMIT_MAX = 10;

/** Sliding-window length for {@link embedSlotsLimiter}, in milliseconds. */
export const EMBED_SLOTS_RATE_LIMIT_INTERVAL_MS = 60_000;

export const embedSlotsLimiter = createRateLimiter({
  interval: EMBED_SLOTS_RATE_LIMIT_INTERVAL_MS,
  maxRequests: EMBED_SLOTS_RATE_LIMIT_MAX,
});
