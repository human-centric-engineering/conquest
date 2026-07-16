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

/**
 * Answer-extraction preview sub-cap (F4.2). Every call runs a structured LLM
 * completion over the respondent's message — real per-turn spend, unlike the
 * deterministic selection strategies. Keyed on the admin user id, who owns the
 * spend. Set a touch higher than the adaptive selection cap (30/min): a preview
 * admin iterating on phrasing fires more extractions than selections, but it's
 * still a paid call, so the ceiling stays in the same order of magnitude.
 */
export const ANSWER_EXTRACTION_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link answerExtractionLimiter}, in milliseconds. */
export const ANSWER_EXTRACTION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const answerExtractionLimiter = createRateLimiter({
  interval: ANSWER_EXTRACTION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: ANSWER_EXTRACTION_RATE_LIMIT_MAX,
});

/**
 * Contradiction-detection preview sub-cap (F4.3). Every call runs a structured LLM
 * completion comparing a respondent's answers — real per-pass spend, like answer
 * extraction. Keyed on the admin user id, who owns the spend. Same ceiling as the
 * answer-extraction cap (60/min): both are paid per-turn-ish previews an admin
 * iterates on before launch.
 */
export const CONTRADICTION_DETECTION_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link contradictionDetectionLimiter}, in milliseconds. */
export const CONTRADICTION_DETECTION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const contradictionDetectionLimiter = createRateLimiter({
  interval: CONTRADICTION_DETECTION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: CONTRADICTION_DETECTION_RATE_LIMIT_MAX,
});

/**
 * Answer-refinement preview sub-cap (F4.4). Every call runs a structured LLM
 * completion deciding whether a respondent's captured answers should change — real
 * per-pass spend, like contradiction detection. Keyed on the admin user id, who owns
 * the spend. Same ceiling as the detection/extraction caps (60/min): all three are
 * paid per-turn-ish previews an admin iterates on before launch.
 */
export const ANSWER_REFINEMENT_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link answerRefinementLimiter}, in milliseconds. */
export const ANSWER_REFINEMENT_RATE_LIMIT_INTERVAL_MS = 60_000;

export const answerRefinementLimiter = createRateLimiter({
  interval: ANSWER_REFINEMENT_RATE_LIMIT_INTERVAL_MS,
  maxRequests: ANSWER_REFINEMENT_RATE_LIMIT_MAX,
});

/**
 * Completion preview sub-cap (F4.5). Shared by both completion routes: the
 * `completion-status` route may dispatch the offer-composer LLM call when the
 * assessment is an offer, and the `complete` route may dispatch the F4.3 sweep on
 * accept — both paid per call. The deterministic assessment itself is free, but
 * keying one limiter on the admin user id keeps the paid sub-flows bounded together.
 * Same ceiling as the detection/extraction/refinement caps (60/min): all are paid
 * per-turn-ish previews an admin iterates on before launch.
 */
export const COMPLETION_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link completionLimiter}, in milliseconds. */
export const COMPLETION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const completionLimiter = createRateLimiter({
  interval: COMPLETION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: COMPLETION_RATE_LIMIT_MAX,
});

/**
 * Design-time evaluation preview sub-cap (F5.1). One call fans out to **seven** judge
 * LLM completions (the whole panel), so it's the most expensive questionnaire sub-flow
 * per request — capped tighter than the per-turn previews. Keyed on the admin user id,
 * who owns the spend. Checked once per run (not per judge): 20 runs/min is ample for an
 * admin iterating on a structure before launch while bounding a hammered "evaluate"
 * button to ~140 judge calls/min.
 */
export const DESIGN_EVALUATION_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link designEvaluationLimiter}, in milliseconds. */
export const DESIGN_EVALUATION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const designEvaluationLimiter = createRateLimiter({
  interval: DESIGN_EVALUATION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: DESIGN_EVALUATION_RATE_LIMIT_MAX,
});

/**
 * Suggestion-apply sub-cap (F5.3). Applying a finding is not LLM work, but it mutates the
 * structure and may **fork** a launched version (a multi-row deep copy) — costlier than a plain
 * edit, so it takes its own per-admin sub-cap rather than only the section 100/min. The
 * accept/decline/edit decisions are cheap row writes and inherit the section cap with no sub-cap.
 * 60/min is ample for an admin working through a review queue while bounding a hammered "apply"
 * button's fork churn. Keyed on the admin user id, who owns the version.
 */
export const EVALUATION_APPLY_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link evaluationApplyLimiter}, in milliseconds. */
export const EVALUATION_APPLY_RATE_LIMIT_INTERVAL_MS = 60_000;

export const evaluationApplyLimiter = createRateLimiter({
  interval: EVALUATION_APPLY_RATE_LIMIT_INTERVAL_MS,
  maxRequests: EVALUATION_APPLY_RATE_LIMIT_MAX,
});

/**
 * Data-slot generation sub-cap (Data Slots feature). One call runs a structured LLM
 * completion over the whole question set to infer the data slots — real paid work, like
 * the design-evaluation panel. Capped per admin so a hammered "Generate data slots" button
 * can't run up the bill. Keyed on the admin user id, who owns the spend.
 */
export const DATA_SLOTS_GENERATION_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link dataSlotsGenerationLimiter}, in milliseconds. */
export const DATA_SLOTS_GENERATION_RATE_LIMIT_INTERVAL_MS = 60_000;

export const dataSlotsGenerationLimiter = createRateLimiter({
  interval: DATA_SLOTS_GENERATION_RATE_LIMIT_INTERVAL_MS,
  maxRequests: DATA_SLOTS_GENERATION_RATE_LIMIT_MAX,
});

/**
 * Single-slot refinement sub-cap (Data Slots feature). One reasoning-model call per refine —
 * cheaper than a whole-set generation but still paid work, and an admin iterates on a slot’s
 * wording several times. Set higher than the generation cap (20/min) to allow that iteration,
 * in the same order as the per-turn previews (60/min). Keyed on the admin user id, who owns the spend.
 */
export const DATA_SLOTS_REFINE_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link dataSlotsRefineLimiter}, in milliseconds. */
export const DATA_SLOTS_REFINE_RATE_LIMIT_INTERVAL_MS = 60_000;

export const dataSlotsRefineLimiter = createRateLimiter({
  interval: DATA_SLOTS_REFINE_RATE_LIMIT_INTERVAL_MS,
  maxRequests: DATA_SLOTS_REFINE_RATE_LIMIT_MAX,
});

/**
 * Assign-orphans sub-cap (Data Slots feature). One reasoning-model call places the version's newly
 * added (unslotted) questions into slots. Triggered automatically when a question is added (the
 * pre-ticked checkbox) and from the admin catch-all button — a few per minute at most, so the
 * generation cap (20/min) is plenty. Keyed on the admin user id, who owns the spend.
 */
export const DATA_SLOTS_ASSIGN_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link dataSlotsAssignLimiter}, in milliseconds. */
export const DATA_SLOTS_ASSIGN_RATE_LIMIT_INTERVAL_MS = 60_000;

export const dataSlotsAssignLimiter = createRateLimiter({
  interval: DATA_SLOTS_ASSIGN_RATE_LIMIT_INTERVAL_MS,
  maxRequests: DATA_SLOTS_ASSIGN_RATE_LIMIT_MAX,
});

/**
 * Generative-authoring sub-cap (compose-from-brief + refine). Each compose run is a
 * two-phase fan-out (one outline call + one call per section), and each refine turn
 * is one reasoning-model call — real paid work, like the design-evaluation panel.
 * Shared by all three generative-authoring routes (compose, compose/stream, refine):
 * an admin iterating on a brief and refining fires several per minute, so 20/min is
 * ample while bounding a hammered "Generate"/"Refine" button. Keyed on the admin
 * user id, who owns the spend.
 */
export const COMPOSE_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link composeLimiter}, in milliseconds. */
export const COMPOSE_RATE_LIMIT_INTERVAL_MS = 60_000;

export const composeLimiter = createRateLimiter({
  interval: COMPOSE_RATE_LIMIT_INTERVAL_MS,
  maxRequests: COMPOSE_RATE_LIMIT_MAX,
});

/**
 * Respondent-report config-assistant sub-cap (F10.1 Phase 4b). Each turn is one reasoning-model
 * call that interviews the admin and proposes report config — real paid work, like a refine turn. An
 * admin chats back and forth several times while crafting, so 60/min (same order as the per-turn
 * previews) is ample while bounding a hammered assistant. Keyed on the admin user id, who owns the spend.
 */
export const REPORT_CONFIG_ASSIST_RATE_LIMIT_MAX = 60;

/** Sliding-window length for {@link reportConfigAssistLimiter}, in milliseconds. */
export const REPORT_CONFIG_ASSIST_RATE_LIMIT_INTERVAL_MS = 60_000;

export const reportConfigAssistLimiter = createRateLimiter({
  interval: REPORT_CONFIG_ASSIST_RATE_LIMIT_INTERVAL_MS,
  maxRequests: REPORT_CONFIG_ASSIST_RATE_LIMIT_MAX,
});

/**
 * Respondent-report preview sub-cap. Each preview runs TWO reasoning-model calls (synthesise sample
 * answers, then generate the report) — the heaviest report sub-flow — so it's capped tighter than the
 * config-assistant turn. 20/min per admin is ample for iterating on config while bounding a hammered
 * "Preview" button. Keyed on the admin user id, who owns the spend.
 */
export const REPORT_PREVIEW_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link reportPreviewLimiter}, in milliseconds. */
export const REPORT_PREVIEW_RATE_LIMIT_INTERVAL_MS = 60_000;

export const reportPreviewLimiter = createRateLimiter({
  interval: REPORT_PREVIEW_RATE_LIMIT_INTERVAL_MS,
  maxRequests: REPORT_PREVIEW_RATE_LIMIT_MAX,
});

/**
 * Cohort-report generation sub-cap (F14.3). Each generate runs the cohort dataset build plus one
 * reasoning-model call over the whole round — a costly, slow sub-flow. Capped tightly at 10/min per
 * admin (the ingest class), keyed on the admin user id who owns the spend, so a hammered "Generate"
 * button can't run up the report bill. The deterministic dataset endpoint is not limited here.
 */
export const COHORT_REPORT_GENERATE_RATE_LIMIT_MAX = 10;

/** Sliding-window length for {@link cohortReportGenerateLimiter}, in milliseconds. */
export const COHORT_REPORT_GENERATE_RATE_LIMIT_INTERVAL_MS = 60_000;

export const cohortReportGenerateLimiter = createRateLimiter({
  interval: COHORT_REPORT_GENERATE_RATE_LIMIT_INTERVAL_MS,
  maxRequests: COHORT_REPORT_GENERATE_RATE_LIMIT_MAX,
});

/**
 * Respondent-report re-run sub-cap (admin "re-run report against a session"). Each re-run queues a
 * revision the maintenance worker then generates — the same costly, slow report sub-flow as a delivered
 * report (one reasoning-model call, plus optional web-search rounds + KB grounding). Capped tightly at
 * 10/min per admin (the ingest class, matching the cohort-report generate cap), keyed on the admin user
 * id who owns the spend, so a hammered "Re-run" button can't run up the report bill. Only the enqueue is
 * limited here; reading the revision history / promoting a revision are cheap and inherit the section cap.
 */
export const REPORT_RERUN_RATE_LIMIT_MAX = 10;

/** Sliding-window length for {@link reportRerunLimiter}, in milliseconds. */
export const REPORT_RERUN_RATE_LIMIT_INTERVAL_MS = 60_000;

export const reportRerunLimiter = createRateLimiter({
  interval: REPORT_RERUN_RATE_LIMIT_INTERVAL_MS,
  maxRequests: REPORT_RERUN_RATE_LIMIT_MAX,
});

/**
 * Config Advisor sub-cap. Each run is two reasoning-model calls (a streamed narrative + a structured
 * analysis), so it's in the same paid class as the design-evaluation panel / compose. Capped at
 * 20/min per admin, keyed on the admin user id who owns the spend, so a hammered "Run advisor"
 * button can't run up the bill while still leaving ample room to iterate (run → tweak → re-run).
 */
export const ADVISOR_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link advisorLimiter}, in milliseconds. */
export const ADVISOR_RATE_LIMIT_INTERVAL_MS = 60_000;

export const advisorLimiter = createRateLimiter({
  interval: ADVISOR_RATE_LIMIT_INTERVAL_MS,
  maxRequests: ADVISOR_RATE_LIMIT_MAX,
});

/**
 * Agent Settings "Explain with AI" sub-cap. Each call is one reasoning-model
 * structured completion explaining a single agent's settings, so it's the same
 * paid class as the advisor. Capped at 20/min per admin, keyed on the admin user
 * id who owns the spend.
 */
export const SETTINGS_ADVISOR_RATE_LIMIT_MAX = 20;

/** Sliding-window length for {@link settingsAdvisorLimiter}, in milliseconds. */
export const SETTINGS_ADVISOR_RATE_LIMIT_INTERVAL_MS = 60_000;

export const settingsAdvisorLimiter = createRateLimiter({
  interval: SETTINGS_ADVISOR_RATE_LIMIT_INTERVAL_MS,
  maxRequests: SETTINGS_ADVISOR_RATE_LIMIT_MAX,
});
