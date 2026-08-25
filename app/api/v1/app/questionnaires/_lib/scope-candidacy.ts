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
import { selectCandidacyExcerpt } from '@/lib/app/questionnaire/scope/candidacy-excerpt';
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
 * How much of the extracted structure travels with the excerpt (F17.22 Phase 3).
 *
 * Section titles are the cheap half and the valuable half — a role- or segment-shaped instrument
 * says who a section is for in its TITLE — so more of them are carried. Question wordings exist
 * here so a screener question ("Which best describes your organisation?") registers, not so the
 * check can read the instrument.
 *
 * **Counts are not a budget.** The first version capped item COUNTS only, so 300 prompts of
 * arbitrary length could quadruple a prompt that already carries a 20k excerpt — on a check whose
 * whole design constraint is being cheap enough to run on every upload, and whose 20s timeout
 * fail-softs to NO verdict. That failure would land on precisely the large routing-shaped
 * instruments this exists to catch. So each item is truncated AND the two lists share a character
 * ceiling; whatever does not fit is dropped, because a truncated list is still evidence.
 */
const MAX_STRUCTURE_SECTION_TITLES = 120;
const MAX_STRUCTURE_QUESTION_PROMPTS = 300;
const MAX_STRUCTURE_TITLE_CHARS = 120;
const MAX_STRUCTURE_PROMPT_CHARS = 200;
const MAX_STRUCTURE_TOTAL_CHARS = 8_000;

/**
 * Truncate each item, then take as many as the character ceiling allows — titles first, since a
 * section title is the strongest structural signal per character in the whole payload.
 */
function withinCharBudget(
  items: string[],
  perItemChars: number,
  budget: number
): [string[], number] {
  const kept: string[] = [];
  let spent = 0;
  for (const item of items) {
    const trimmed = item.slice(0, perItemChars).trim();
    if (trimmed.length === 0) continue;
    if (spent + trimmed.length > budget) break;
    kept.push(trimmed);
    spent += trimmed.length;
  }
  return [kept, spent];
}

/**
 * The extracted structure for the candidacy check, or empty lists when it cannot be read.
 *
 * Fail-soft like everything else here: structure is corroborating evidence, and a failed read is a
 * reason to check with less rather than not to check. Deliberately queried from the just-persisted
 * version rather than threaded through every ingest caller — the graph is written before the check
 * runs in all four paths (fresh/re-ingest × streaming/non-streaming).
 */
async function loadCandidacyStructure(
  versionId: string,
  log: RouteLogger
): Promise<{ sectionTitles: string[]; questionPrompts: string[] }> {
  try {
    // Read questions THROUGH their sections rather than version-wide. The prompt tells the model
    // these are "in document order", and `AppQuestionSlot.ordinal` is only globally ordered because
    // ingestion happens to assign it that way — the Structure editor's add-question route counts
    // within the section, so a version-wide `orderBy: { ordinal }` has ties and both the order and
    // the `take` cut point become arbitrary. This is the shape `buildRoutingAnalysisInput` uses.
    const sections = await prisma.appQuestionnaireSection.findMany({
      where: { versionId },
      select: {
        title: true,
        questions: {
          select: { prompt: true },
          orderBy: { ordinal: 'asc' },
        },
      },
      orderBy: { ordinal: 'asc' },
      take: MAX_STRUCTURE_SECTION_TITLES,
    });

    const [sectionTitles, titleChars] = withinCharBudget(
      sections.map((s) => s.title),
      MAX_STRUCTURE_TITLE_CHARS,
      MAX_STRUCTURE_TOTAL_CHARS
    );
    const [questionPrompts] = withinCharBudget(
      sections
        .flatMap((s) => s.questions.map((q) => q.prompt))
        .slice(0, MAX_STRUCTURE_QUESTION_PROMPTS),
      MAX_STRUCTURE_PROMPT_CHARS,
      MAX_STRUCTURE_TOTAL_CHARS - titleChars
    );
    return { sectionTitles, questionPrompts };
  } catch (err) {
    log.warn('scope candidacy: structure read threw; checking on the document text alone', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sectionTitles: [], questionPrompts: [] };
  }
}

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

  // Composed, not sliced (F17.22 Phase 3): the head, the tail, and a window around every passage
  // that uses routing language. The old head-slice read the wrong 20,000 characters of exactly the
  // documents this check exists to catch — a routing page or guardrails tab usually sits behind the
  // questions, and a workbook's Routing sheet flattens last of all.
  const excerpt = selectCandidacyExcerpt(documentText);
  const structure = await loadCandidacyStructure(versionId, log);
  if (excerpt.omittedChars > 0) {
    log.info('scope candidacy: reading a composed excerpt', {
      versionId,
      documentChars: documentText.length,
      excerptChars: excerpt.text.length,
      // What lets an operator tell "it read the routing page and still said no" from "it never
      // reached the routing page" — previously unanswerable from the logs.
      matchedTerms: excerpt.matchedTerms,
    });
  }

  const startedAt = Date.now();
  let result: ScopeCandidacyResult;
  try {
    const dispatch = await capabilityDispatcher.dispatch(
      DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
      {
        documentText: excerpt.text,
        documentFileName: fileName,
        versionId,
        ...(structure.sectionTitles.length > 0 ? { sectionTitles: structure.sectionTitles } : {}),
        ...(structure.questionPrompts.length > 0
          ? { questionPrompts: structure.questionPrompts }
          : {}),
      },
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
 * How many failed `routing_analysis` runs the auto-trigger will tolerate before it stops offering
 * to fire itself. Two: one transient failure is worth retrying on the next tab visit; two in a row
 * is a configuration problem that retrying cannot fix.
 */
const MAX_AUTO_TRIGGER_ATTEMPTS = 2;

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
  // just because the admin revisits the tab. It is NOT recorded for the early-return paths ahead of
  // any model call (rate limited, no questions, agent unseeded) — those stay eligible to retry on a
  // later visit, which is the correct behaviour for "nothing was actually attempted yet".
  //
  // A FAILED run used to count the same as a succeeded one (F17.22 Phase 3), which meant one
  // provider blip during the first tab visit disabled the automation permanently for that version,
  // silently and with nothing on screen to say so. Only a success is now conclusive.
  const [succeeded, failures] = await Promise.all([
    prisma.appAiRun.findFirst({
      where: { versionId, kind: 'routing_analysis', status: 'succeeded' },
      select: { id: true },
    }),
    prisma.appAiRun.count({ where: { versionId, kind: 'routing_analysis', status: 'failed' } }),
  ]);

  if (succeeded !== null) return false;

  // Bounded, because "retry until it works" over a paid model call with a misconfigured provider is
  // a bill, not a recovery: the automation gets one more attempt, and after that the admin's own
  // button is the way back in (it reports its errors, which the silent auto-run deliberately does
  // not). Legacy rows are unaffected — `status` defaults to `succeeded`, so anything written before
  // failures were recorded still reads as conclusive.
  return failures < MAX_AUTO_TRIGGER_ATTEMPTS;
}
