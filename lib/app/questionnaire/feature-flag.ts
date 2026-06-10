import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import {
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_FLAG,
} from '@/lib/app/questionnaire/constants';
import { isFeatureEnabled } from '@/lib/feature-flags';

// Re-exported so the feature-flag module stays the natural home for the flag
// name. The constant itself lives in the dependency-light `constants.ts` so leaf
// consumers (the seed) can import it without this module's HTTP/DB deps.
export {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
};

/**
 * Whether the questionnaire app is enabled. Thin wrapper over Sunrise's
 * {@link isFeatureEnabled}.
 *
 * Server-only: it resolves the flag from the database. It imports no specifier
 * banned by the `lib/app/**` boundary, so it's safe to live here, but only call
 * it from a server context (route handler, server component, seed).
 */
export async function isQuestionnairesEnabled(): Promise<boolean> {
  return isFeatureEnabled(APP_QUESTIONNAIRES_FLAG);
}

/**
 * Whether the F4.1 **adaptive** selection strategy may run. Requires BOTH the
 * master app flag and the adaptive sub-flag — adaptive is a paid (embedding +
 * LLM) sub-feature, opt-in on top of an already-enabled app. The next-question
 * route consults this to decide whether to wire adaptive's deps; when it returns
 * `false`, a version configured for `adaptive` degrades to `weighted`.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isAdaptiveSelectionEnabled(): Promise<boolean> {
  const [app, adaptive] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_ADAPTIVE_FLAG),
  ]);
  return app && adaptive;
}

/**
 * Whether F4.2 **answer extraction** may run. Requires BOTH the master app flag
 * and the answer-extraction sub-flag — extraction spends an LLM call every turn,
 * so it's opt-in on top of an already-enabled app (the same shape as
 * {@link isAdaptiveSelectionEnabled}). The extract-answer route consults this and
 * returns 404 when it's `false`, so a disabled sub-feature looks like a missing
 * route rather than a 401.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isAnswerExtractionEnabled(): Promise<boolean> {
  const [app, extraction] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG),
  ]);
  return app && extraction;
}

/**
 * Whether F4.3 **contradiction detection** may run. Requires BOTH the master app
 * flag and the contradiction-detection sub-flag — detection spends an LLM call per
 * pass, so it's opt-in on top of an already-enabled app (the same shape as
 * {@link isAnswerExtractionEnabled}). The detect-contradictions route consults this
 * and returns 404 when it's `false`, so a disabled sub-feature looks like a missing
 * route rather than a 401.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isContradictionDetectionEnabled(): Promise<boolean> {
  const [app, detection] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG),
  ]);
  return app && detection;
}

/**
 * Whether F4.4 **answer refinement** may run. Requires BOTH the master app flag and
 * the answer-refinement sub-flag — refinement spends an LLM call per pass, so it's
 * opt-in on top of an already-enabled app (the same shape as
 * {@link isContradictionDetectionEnabled}). The refine-answer route consults this and
 * returns 404 when it's `false`, so a disabled sub-feature looks like a missing route
 * rather than a 401.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isAnswerRefinementEnabled(): Promise<boolean> {
  const [app, refinement] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG),
  ]);
  return app && refinement;
}

/**
 * Whether F4.5 **completion-offer composition** may run. Requires BOTH the master
 * app flag and the completion sub-flag — composing the offer spends an LLM call, so
 * it's opt-in on top of an already-enabled app (the same shape as
 * {@link isAnswerRefinementEnabled}).
 *
 * Unlike the other sub-features, a disabled flag does NOT 404 the completion-status
 * route: the deterministic completion *assessment* is always available under the
 * master flag, and only the LLM offer *phrasing* is gated — so the route returns the
 * assessment without a composed offer when this is `false`.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isCompletionEnabled(): Promise<boolean> {
  const [app, completion] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_COMPLETION_FLAG),
  ]);
  return app && completion;
}

/**
 * Whether the F5.1 **design-time evaluation** judge panel may run. Requires BOTH the
 * master app flag and the design-evaluation sub-flag — a run spends seven LLM calls
 * (one per judge), so it's opt-in on top of an already-enabled app (the same shape as
 * {@link isCompletionEnabled}). The evaluate-preview route consults this and returns
 * 404 when it's `false`, so a disabled sub-feature looks like a missing route rather
 * than a 401 — the whole route is paid LLM work, so unlike completion there is no free
 * deterministic result to fall back to.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isDesignEvaluationEnabled(): Promise<boolean> {
  const [app, evaluation] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG),
  ]);
  return app && evaluation;
}

/**
 * Flag gate for `/api/v1/app/**` route handlers. Returns a `404` {@link Response}
 * when the questionnaire app is disabled — so a switched-off app is
 * indistinguishable from a route that doesn't exist — or `null` when enabled.
 *
 * This is the gating template every questionnaire route follows: call it first,
 * before any auth or handler work.
 *
 * ```ts
 * export async function GET() {
 *   const blocked = await ensureQuestionnairesEnabled();
 *   if (blocked) return blocked;
 *   // …withAuth / withAdminAuth / handler work…
 * }
 * ```
 *
 * Server-only (resolves the flag from the database).
 */
export async function ensureQuestionnairesEnabled(): Promise<Response | null> {
  if (await isQuestionnairesEnabled()) {
    return null;
  }
  return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
}

/**
 * Wrap a route handler so the flag gate runs **before** anything else (auth,
 * handler work) — the order a disabled app needs to look like a missing route
 * rather than a 401. Collapses the per-verb `ensureQuestionnairesEnabled()`
 * boilerplate into one composable wrapper, so a new route can't accidentally
 * place the gate after `withAdminAuth` and leak the app's existence.
 *
 * ```ts
 * export const PATCH = withQuestionnairesEnabled(handleVersionMetaPatch);
 * ```
 */
export function withQuestionnairesEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    const blocked = await ensureQuestionnairesEnabled();
    if (blocked) return blocked;
    return handler(request, context);
  };
}

/**
 * Whether the F6.1 **live respondent sessions** surface may run. Requires BOTH the master
 * app flag and the live-sessions sub-flag — the streaming turn loop spends LLM calls per
 * turn AND opens a respondent-facing surface (incl. the no-login anonymous path), so it
 * dark-launches independently of the admin previews. The session-create and messages
 * routes consult this and 404 when it's `false`, so a disabled surface looks like a missing
 * route rather than a 401.
 *
 * Server-only (resolves both flags from the database).
 */
export async function isLiveSessionsEnabled(): Promise<boolean> {
  const [app, live] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG),
  ]);
  return app && live;
}

/**
 * Flag gate for the live-sessions routes — 404 when either the master flag or the
 * live-sessions sub-flag is off, `null` when both are on. The {@link ensureQuestionnairesEnabled}
 * analogue for the respondent surface; call it first, before any auth or handler work.
 *
 * Server-only (resolves both flags from the database).
 */
export async function ensureLiveSessionsEnabled(): Promise<Response | null> {
  if (await isLiveSessionsEnabled()) {
    return null;
  }
  return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
}

/**
 * Wrap a live-sessions route handler so the live-sessions gate runs **before** anything
 * else (auth, handler work) — the order a disabled surface needs to look like a missing
 * route rather than a 401. The {@link withQuestionnairesEnabled} analogue for the
 * respondent surface.
 *
 * ```ts
 * export const POST = withLiveSessionsEnabled(withAuth(handleCreateSession));
 * ```
 */
export function withLiveSessionsEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    const blocked = await ensureLiveSessionsEnabled();
    if (blocked) return blocked;
    return handler(request, context);
  };
}

/**
 * Whether F6.2 **voice input** may run — the respondent transcribe endpoint that turns recorded
 * audio into text via Sunrise's audio provider (Whisper). Requires the master app flag, the
 * **live-sessions** flag, AND the voice-input sub-flag. Voice depends on live-sessions, not just
 * coexists with it: a transcript is only useful when the respondent can then send it through the
 * live `/messages` turn loop — with live-sessions off that route 404s, so transcription would be a
 * dead (but still paid) Whisper call. Gating voice behind live-sessions keeps the surface coherent
 * and means turning live-sessions off also closes the paid audio path. The voice sub-flag remains
 * an independent opt-in *on top of* that prerequisite (every call spends per-minute cost). The
 * transcribe route consults this and 404s when it's `false`, so a disabled sub-feature looks like a
 * missing route rather than a 401.
 *
 * Server-only (resolves the flags from the database).
 */
export async function isVoiceInputEnabled(): Promise<boolean> {
  const [app, live, voice] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_VOICE_INPUT_FLAG),
  ]);
  return app && live && voice;
}

/**
 * Whether **attachment input** may run — a respondent attaching images/documents to a
 * `/messages` turn for the answer-extractor to read. Like voice, it depends on live-sessions
 * (attachments only matter inside the live turn loop) and is an independent opt-in on top
 * (multimodal turns cost more and need a vision/document-capable model). The chat surface
 * shows the affordance only when this is true, and the `/messages` route ignores any
 * attachments a client sends while it's off — so the paid multimodal path stays closed.
 *
 * Server-only (resolves the flags from the database).
 */
export async function isAttachmentInputEnabled(): Promise<boolean> {
  const [app, live, attachments] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG),
  ]);
  return app && live && attachments;
}

/**
 * Whether **conversational question phrasing** may run — the interviewer pass that renders the
 * next question as warm, natural prose instead of the verbatim prompt. Like voice/attachments it
 * depends on live-sessions (phrasing only applies inside the live `/messages` turn loop) and is
 * an independent opt-in on top (one extra LLM call per asked question). When off, the route
 * surfaces the verbatim prompt — no extra spend, the pre-existing behaviour. Requires the master
 * flag AND the live-sessions flag AND the phrasing sub-flag.
 *
 * Server-only (resolves the flags from the database).
 */
export async function isQuestionPhrasingEnabled(): Promise<boolean> {
  const [app, live, phrasing] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG),
  ]);
  return app && live && phrasing;
}

/**
 * Flag gate for the F6.2 voice-input (transcribe) route — 404 when either the master flag or the
 * voice-input sub-flag is off, `null` when both are on. The {@link ensureLiveSessionsEnabled}
 * analogue for the transcribe endpoint; call it first, before any auth or handler work.
 *
 * Server-only (resolves both flags from the database).
 */
export async function ensureVoiceInputEnabled(): Promise<Response | null> {
  if (await isVoiceInputEnabled()) {
    return null;
  }
  return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
}

/**
 * Wrap the transcribe route handler so the voice-input gate runs **before** anything else (auth,
 * handler work) — the order a disabled sub-feature needs to look like a missing route rather than a
 * 401. The {@link withLiveSessionsEnabled} analogue for the voice-input surface.
 *
 * ```ts
 * export const POST = withVoiceInputEnabled(handleTranscribe);
 * ```
 */
export function withVoiceInputEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    const blocked = await ensureVoiceInputEnabled();
    if (blocked) return blocked;
    return handler(request, context);
  };
}

/**
 * Whether F6.3 **cost-cap enforcement** may run for the live turn loop. Requires the master
 * app flag, the **live-sessions** flag, AND the cost-cap sub-flag. The cap only applies to the
 * live `/messages` turn loop (it's about *respondent* spend), so enforcement depends on
 * live-sessions the same way voice does — turning live-sessions off also turns off the budget
 * check. When this returns `false` the messages route runs turns with no budget check even if a
 * version sets `costBudgetUsd`; there's no route to 404 (unlike the other sub-features, this gates
 * a behaviour *inside* an already-gated route, not a route of its own).
 *
 * Server-only (resolves the flags from the database).
 */
export async function isCostCapEnforcementEnabled(): Promise<boolean> {
  const [app, live, costCap] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_COST_CAP_FLAG),
  ]);
  return app && live && costCap;
}
