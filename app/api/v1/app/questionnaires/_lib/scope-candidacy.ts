/**
 * Ingestion-time Adaptive Scope candidacy check (P17.19).
 *
 * Runs on every fresh questionnaire ingestion (new ingest + re-ingest, streaming and non-streaming)
 * and decides whether the uploaded document is worth flagging as a routing candidate — NOT the
 * Routing Analyst itself, which does the actual topic/rule proposal and is auto-triggered from the
 * Topics tab when this check fires (`resolveAutoTriggerPending`, Phase 3).
 *
 * Fail-soft throughout, the same discipline as the ingest verify/repair pass
 * (`orchestrate-extraction.ts`): a missing agent, no provider, a timeout, or an unparseable reply
 * all resolve to "not run" (`null`) rather than blocking or failing the ingest waiting on it.
 *
 * Server-only (Prisma + capability dispatch). Boundary note: this lives under `app/api/**`, so
 * importing Prisma / the dispatcher here is fine (unlike `lib/app/**`).
 */

import 'server-only';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import type { getRouteLogger } from '@/lib/api/context';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { narrowAdaptiveScopeSettings } from '@/lib/app/questionnaire/scope/types';
import {
  validateScopeCandidacy,
  type ScopeCandidacyResult,
  type ScopeCandidacyVerdict,
} from '@/lib/app/questionnaire/scope/candidacy-schema';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

type RouteLogger = Awaited<ReturnType<typeof getRouteLogger>>;

/**
 * Cap on how much of the source document the cheap candidacy check reads. Detecting a routing
 * signal needs far less than the Routing Analyst's exhaustive read — the sections that announce
 * conditionality (an intro, a "how to use this" page, a routing tab) are concentrated, not spread
 * evenly across a long instrument. Keeping this well below the analyst's uncapped read is what
 * keeps the check cheap enough to run unconditionally on every upload.
 */
const MAX_CANDIDACY_DOCUMENT_CHARS = 20_000;

/**
 * Trim a validated candidacy result to the {@link ScopeCandidacyVerdict} shape carried across the
 * ingest response/stream and the Topics tab — `signals` (which may hold document quotes) stays
 * server-side. One place, so the ingest-response verdict and the auto-trigger verdict can't drift.
 */
function trimCandidacyVerdict(result: ScopeCandidacyResult): ScopeCandidacyVerdict {
  return {
    isCandidate: result.isCandidate,
    confidence: result.confidence,
    summary: result.summary,
  };
}

/**
 * A version is "untouched" by Adaptive Scope when none of these three facts hold — the one
 * predicate both the ingestion-time candidacy check and the Phase 3 auto-trigger gate on, so a
 * future fourth condition can't be added to one and silently forgotten on the other.
 */
function isVersionUntouchedByAdaptiveScope(current: {
  enabled: boolean;
  hasDraft: boolean;
  hasAuthoredTopic: boolean;
}): boolean {
  return !current.enabled && !current.hasDraft && !current.hasAuthoredTopic;
}

/**
 * Is this version worth checking at all? A detector for a FRESH, unrouted document — not a recheck
 * of one an admin has already looked at. The check is a no-op (no LLM call, no `AppAiRun`) when:
 *  - Adaptive Scope is already enabled for the version, or
 *  - the version already carries a topic an admin or the analyst authored (`source !== 'seeded'`
 *    — the auto-seeded one-topic-per-section set doesn't count), or
 *  - a Routing Analyst draft is already pending review.
 *
 * Exported so a streaming route can pre-check before announcing a "checking…" progress phase —
 * `checkAdaptiveScopeCandidacy` itself re-checks this internally regardless, so a caller that
 * skips the pre-check still gets the same fail-soft, no-op-when-ineligible behaviour.
 */
export async function isEligibleForScopeCandidacy(versionId: string): Promise<boolean> {
  const [config, draft, authoredTopic] = await Promise.all([
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { adaptiveScope: true },
    }),
    prisma.appQuestionnaireTopicDraft.findUnique({ where: { versionId }, select: { id: true } }),
    prisma.appQuestionnaireTopic.findFirst({
      where: { versionId, source: { not: 'seeded' } },
      select: { id: true },
    }),
  ]);
  return isVersionUntouchedByAdaptiveScope({
    enabled: Boolean(config && narrowAdaptiveScopeSettings(config.adaptiveScope).enabled),
    hasDraft: Boolean(draft),
    hasAuthoredTopic: Boolean(authoredTopic),
  });
}

export interface CheckAdaptiveScopeCandidacyParams {
  versionId: string;
  /** The parsed source document's full text (the same text the extractor/analyst read). */
  documentText: string;
  fileName: string;
  adminId: string;
  log: RouteLogger;
}

/**
 * Run the candidacy check for a freshly-ingested version. Returns the trimmed verdict for the
 * caller to surface on the ingest response/stream, or `null` when the version was ineligible or
 * the check could not be obtained (never a thrown error — ingestion must complete either way).
 *
 * On a real verdict, records an `AppAiRun` (kind `scope_candidacy`) and caches the full result on
 * `AppQuestionnaireVersion.adaptiveScopeCandidate` for cheap reads without joining the run table.
 * Both writes are best-effort: a provenance/cache miss must never fail a completed ingest.
 */
export async function checkAdaptiveScopeCandidacy(
  params: CheckAdaptiveScopeCandidacyParams
): Promise<ScopeCandidacyVerdict | null> {
  const { versionId, documentText, fileName, adminId, log } = params;

  try {
    if (!(await isEligibleForScopeCandidacy(versionId))) return null;
  } catch (err) {
    // A provenance/eligibility read must never fail a completed ingest — the same "never throws"
    // contract as the rest of this check. An eligibility read that can't be trusted is treated as
    // "don't check", not as "check anyway": the version may already be scoped, and this must not
    // race a real authoring effort.
    log.warn('scope candidacy: eligibility check threw; skipping', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let agent: {
    id: string;
    provider: string;
    model: string;
    fallbackProviders: string[];
  } | null;
  try {
    agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
  } catch (err) {
    log.warn('scope candidacy: agent lookup threw; skipping', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!agent) {
    log.warn('scope candidacy: agent not seeded; skipping', {
      slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
    });
    return null;
  }

  // Flush the built-in + app capability handlers before dispatching — this may be the first
  // capability touch on a fresh server process (same one-shot, idempotent flush the extractor uses).
  registerBuiltInCapabilities();

  const truncatedText =
    documentText.length > MAX_CANDIDACY_DOCUMENT_CHARS
      ? documentText.slice(0, MAX_CANDIDACY_DOCUMENT_CHARS)
      : documentText;

  const startedAt = Date.now();
  let result: ScopeCandidacyResult;
  try {
    const dispatch = await capabilityDispatcher.dispatch(
      DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
      { documentText: truncatedText, documentFileName: fileName, versionId },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          candidacyAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );
    if (!dispatch.success || !dispatch.data) {
      log.warn('scope candidacy: dispatch failed; skipping', { code: dispatch.error?.code });
      return null;
    }
    const validated = validateScopeCandidacy((dispatch.data as { result?: unknown }).result);
    if (!validated.ok) {
      log.warn('scope candidacy: unparseable result; skipping', { issues: validated.issues });
      return null;
    }
    result = validated.value;
  } catch (err) {
    log.warn('scope candidacy: check threw; skipping', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const durationMs = Date.now() - startedAt;

  // Re-check eligibility now that the (up to 20s) LLM call has finished — the version may have
  // become genuinely authored while this was in flight (an admin flipped `adaptiveScope.enabled`,
  // or an analyst draft landed, on the SAME version this re-ingest is checking). Writing a stale
  // verdict onto a version that has since been authored is exactly the race `isEligibleForScopeCandidacy`
  // exists to prevent — only the write is skipped; the verdict is still returned to THIS caller
  // (it describes the document, not the version's current authoring state, so it's harmless to
  // report once). A failed re-check is NOT evidence of a real conflict, so it proceeds with the
  // write rather than discarding a verdict that just cost a real LLM call.
  let stillEligible = true;
  try {
    stillEligible = await isEligibleForScopeCandidacy(versionId);
  } catch (err) {
    log.warn('scope candidacy: post-check eligibility re-check threw; writing anyway', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!stillEligible) {
    log.warn('scope candidacy: version became ineligible while checking; skipping persistence', {
      versionId,
    });
    return trimCandidacyVerdict(result);
  }

  void recordAiRun({
    subjectKind: 'version',
    subjectId: versionId,
    versionId,
    kind: 'scope_candidacy',
    provider: agent.provider || 'n/a',
    model: agent.model || 'n/a',
    outputSnapshot: result,
    durationMs,
    detail: { isCandidate: result.isCandidate, confidence: result.confidence, fileName },
    triggeredByUserId: adminId,
  });

  try {
    await prisma.appQuestionnaireVersion.update({
      where: { id: versionId },
      data: { adaptiveScopeCandidate: jsonInput(result) },
      select: { id: true },
    });
  } catch (err) {
    log.error('scope candidacy: failed to cache verdict on version', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return trimCandidacyVerdict(result);
}

/* -------------------------------------------------------------------------- */
/* Auto-trigger eligibility (F17.19 Phase 3)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the cached candidacy verdict (Phase 1), trimmed for client display. Null if never checked,
 * ineligible at check time, or malformed.
 *
 * Split out from {@link resolveAutoTriggerPending} so a caller that already runs several
 * independent queries in a `Promise.all` (the Topics route's GET handler does) can fold this one
 * in alongside them — this read has no dependency on the topic set, draft or settings, unlike the
 * eligibility check that follows it.
 */
export async function loadCachedCandidacyVerdict(
  versionId: string
): Promise<ScopeCandidacyVerdict | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { adaptiveScopeCandidate: true },
  });
  const validated = version?.adaptiveScopeCandidate
    ? validateScopeCandidacy(version.adaptiveScopeCandidate)
    : null;
  return validated?.ok ? trimCandidacyVerdict(validated.value) : null;
}

/**
 * Decide whether the Topics tab should auto-invoke the Routing Analyst right now, given the
 * verdict {@link loadCachedCandidacyVerdict} already read.
 *
 * The candidacy check only ever WRITES a verdict at ingestion time; whether it still applies by
 * the time an admin opens the tab is a later-in-time question, so eligibility is read fresh here:
 * a draft may have landed since (from this very auto-trigger, or a manual run), a topic may have
 * been hand-authored, or the version may already be enabled.
 *
 * `hasAuthoredTopic` / `hasDraft` / `enabled` are passed in rather than re-queried — the Topics
 * route's GET handler already loaded the topic set, the draft and the settings for its own
 * response, and re-querying the same three facts here could disagree with what it actually
 * returns in the same payload.
 *
 * **Not locked.** Two GETs for the same version racing before either has produced an `AppAiRun`
 * row can both see `pending: true` and both auto-fire — the same class of risk the manual "Run"
 * button already carries if two admins click it at once (no reservation there either). Accepted
 * rather than solved with a lock: the failure mode is a doubled LLM call and a later draft POST
 * silently winning over an earlier one (`AppQuestionnaireTopicDraft.versionId` is unique, so it's
 * last-write-wins, not corruption), and it needs two tabs open on the same fresh version within
 * the same request window to happen at all.
 */
export async function resolveAutoTriggerPending(
  versionId: string,
  candidacy: ScopeCandidacyVerdict | null,
  current: { hasAuthoredTopic: boolean; hasDraft: boolean; enabled: boolean }
): Promise<boolean> {
  if (!candidacy?.isCandidate) return false;
  if (!isVersionUntouchedByAdaptiveScope(current)) return false;

  // The durable "already tried" signal. Unlike the draft — which a discard deletes — this survives
  // a rejected proposal, so declining what the analyst proposed never re-fires the same auto-run
  // just because the admin revisits the tab. Recorded for both a successful AND a failed real run
  // (the analyse/stream route logs `status: 'failed'` from inside its dispatch), but NOT for the
  // early-return paths ahead of any model call (rate limited, no questions, agent unseeded) — those
  // stay eligible to retry on a later visit, which is the correct behaviour for "nothing was
  // actually attempted yet".
  const priorRun = await prisma.appAiRun.findFirst({
    where: { versionId, kind: 'routing_analysis' },
    select: { id: true },
  });

  return priorRun === null;
}
