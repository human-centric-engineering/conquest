/**
 * Running the Routing Analyst — the shared seam beneath the SSE route and the ingest pipeline.
 *
 * Two callers, one implementation (F17.22 Phase 2):
 *
 * - `POST …/topics/analyse/stream` — the admin pressed a button and is watching phase events.
 * - The **streaming** ingest and re-ingest routes — the candidacy check just said this document
 *   describes routing, and the admin is already watching an upload progress stream, so the
 *   proposal is produced there and then rather than on a later tab visit.
 *
 * What must not be duplicated is the `AppAiRun` bookkeeping. A `routing_analysis` run — succeeded
 * OR failed — is the durable "already tried" signal `resolveAutoTriggerPending` reads, so a second
 * copy of this logic that forgot to record one would make the Topics tab re-propose forever, and
 * one that recorded the wrong status would disable the automation for the life of the version.
 *
 * Server-only: lives under `app/api/**`, so Prisma and the capability dispatcher are in bounds.
 */

import 'server-only';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { getRouteLogger } from '@/lib/api/context';

import {
  ANALYSE_ROUTING_CAPABILITY_SLUG,
  QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  validateRoutingAnalysis,
  type RoutingAnalysisResult,
} from '@/lib/app/questionnaire/scope/analysis-schema';
import { narrowProposedTopicSet, type ProposedTopicSet } from '@/lib/app/questionnaire/scope/types';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  buildRoutingAnalysisInput,
  saveTopicDraft,
  type RoutingAnalysisRouteInput,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { isEligibleForScopeCandidacy } from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';

type RouteLogger = Awaited<ReturnType<typeof getRouteLogger>>;

/** The analyst agent's binding, as both callers need it. */
export interface RoutingAnalystAgent {
  id: string;
  provider: string;
  model: string;
  fallbackProviders: string[];
}

/** Load the Routing Analyst agent, or `null` when it was never seeded. */
export async function loadRoutingAnalystAgent(): Promise<RoutingAnalystAgent | null> {
  return prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
}

/**
 * Project the analyst's validated result onto the stored {@link ProposedTopicSet}.
 *
 * `replacesExisting` is stamped here, not asked of the model: whether a proposed key collides with
 * a live topic is a fact about the database, and a model asked to self-report it would sometimes be
 * wrong about the one thing the review surface uses to say "this replaces what you have".
 */
export function toProposedSet(
  result: RoutingAnalysisResult,
  existingKeys: ReadonlySet<string>,
  generatedAt: string
): ProposedTopicSet {
  const built: ProposedTopicSet = {
    v: 1,
    topics: result.topics.map((topic) => ({
      key: topic.key,
      label: topic.label,
      phase: topic.phase,
      criteria: topic.criteria,
      depth: topic.depth,
      members: { questionKeys: topic.questionKeys, dataSlotKeys: topic.dataSlotKeys },
      rationale: topic.rationale,
      ...(topic.sourceQuote ? { sourceQuote: topic.sourceQuote } : {}),
      ...(existingKeys.has(topic.key) ? { replacesExisting: true } : {}),
    })),
    rules: result.rules.map((rule) => ({
      dataSlotKey: rule.dataSlotKey,
      operator: rule.operator,
      value: rule.value,
      action: rule.action,
      topicKey: rule.topicKey,
      rationale: rule.rationale,
      ...(rule.sourceQuote ? { sourceQuote: rule.sourceQuote } : {}),
    })),
    gaps: result.gaps.map((gap) => ({
      sourceQuote: gap.sourceQuote,
      explanation: gap.explanation,
    })),
    ...(result.maxConditionalTopics !== undefined
      ? { maxConditionalTopics: result.maxConditionalTopics }
      : {}),
    ...(result.fallbackTopicKeys !== undefined
      ? { fallbackTopicKeys: result.fallbackTopicKeys }
      : {}),
    ...(result.checkTopicPreference !== undefined
      ? { checkTopicPreference: result.checkTopicPreference }
      : {}),
    summary: result.summary,
    fromDocument: result.fromDocument,
    generatedAt,
  };

  // Through the SAME narrow the DB read uses, and that is the point rather than belt-and-braces:
  // this object is both persisted AND streamed to the card, so anything the narrow does on the way
  // back out — correcting `light` depth on an always-run topic, dropping a settings key naming no
  // proposed topic — must already have happened here, or the draft the admin reviews live differs
  // from the one they would see after a refresh. It cannot return null on input this function just
  // built from a validated result, but the fallback keeps the signature total.
  return narrowProposedTopicSet(built) ?? built;
}

export interface DispatchRoutingAnalysisParams {
  versionId: string;
  adminId: string;
  agent: RoutingAnalystAgent;
  input: RoutingAnalysisRouteInput;
  /** The admin's free-text steer for this run, when they gave one. */
  instructions?: string;
  /** When the caller started timing, so the recorded run measures the whole attempt. */
  startedAt: number;
  log: RouteLogger;
}

export type DispatchRoutingAnalysisOutcome =
  { ok: true; result: RoutingAnalysisResult } | { ok: false; code: string; message: string };

/**
 * Run the analyst and validate what came back. Records a **failed** `AppAiRun` on either failure
 * path (dispatch error, unusable shape) before returning — never throws, so a caller mid-stream can
 * report the failure rather than turn an open response into a 5xx.
 *
 * Re-validating the dispatcher's `unknown` payload rather than asserting it is deliberate: a
 * capability that ever changed shape fails here instead of writing a malformed draft.
 */
export async function dispatchRoutingAnalysis(
  params: DispatchRoutingAnalysisParams
): Promise<DispatchRoutingAnalysisOutcome> {
  const { versionId, adminId, agent, input, instructions, startedAt, log } = params;

  const recordFailure = (message: string) => {
    void recordAiRun({
      subjectKind: 'version',
      subjectId: versionId,
      versionId,
      kind: 'routing_analysis',
      status: 'failed',
      provider: agent.provider || 'resolved-at-runtime',
      model: agent.model || 'resolved-at-runtime',
      durationMs: Date.now() - startedAt,
      error: message,
      triggeredByUserId: adminId,
    });
  };

  registerBuiltInCapabilities();
  const dispatch = await capabilityDispatcher.dispatch(
    ANALYSE_ROUTING_CAPABILITY_SLUG,
    {
      questions: input.questions,
      goal: input.goal,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      dataSlots: input.dataSlots,
      ...(input.documentText ? { documentText: input.documentText } : {}),
      ...(input.documentFileName ? { documentFileName: input.documentFileName } : {}),
      existingTopics: input.existingTopics,
      ...(instructions ? { instructions } : {}),
      versionId,
    },
    {
      userId: adminId,
      agentId: agent.id,
      entityContext: {
        routingAnalystAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success) {
    const code = dispatch.error?.code ?? 'ROUTING_ANALYSIS_FAILED';
    const message = dispatch.error?.message ?? 'The routing analysis could not be completed.';
    log.error('Routing analysis dispatch failed', { versionId, code, message });
    recordFailure(message);
    return { ok: false, code, message };
  }

  const parsed = validateRoutingAnalysis(
    (dispatch.data as { result?: unknown } | undefined)?.result
  );
  if (!parsed.ok) {
    log.error('Routing analysis returned an unexpected shape', {
      versionId,
      issues: parsed.issues.map((issue) => issue.path.join('.')),
    });
    const message = 'The routing analysis returned an unexpected result. Please try again.';
    recordFailure(message);
    return { ok: false, code: 'ROUTING_ANALYSIS_INVALID', message };
  }

  return { ok: true, result: parsed.value };
}

export interface PersistRoutingAnalysisParams {
  questionnaireId: string;
  versionId: string;
  adminId: string;
  clientIp: string;
  agent: RoutingAnalystAgent;
  input: RoutingAnalysisRouteInput;
  result: RoutingAnalysisResult;
  startedAt: number;
  log: RouteLogger;
  /**
   * How this run was asked for. `admin` is the button (or the Topics tab's auto-trigger, which is
   * the same request); `ingest` is the streaming upload proposing without being asked. Recorded on
   * the audit entry so "where did these topics come from" has an answer that does not depend on
   * remembering which release added which trigger.
   */
  trigger: 'admin' | 'ingest';
}

export interface PersistedRoutingAnalysis {
  draft: ProposedTopicSet;
  replacedCount: number;
  uncoveredQuestionCount: number;
}

/**
 * Save the proposal as the version's pending draft, and record what it proposed — the succeeded
 * `AppAiRun`, the admin audit entry, and the route log.
 */
export async function persistRoutingAnalysis(
  params: PersistRoutingAnalysisParams
): Promise<PersistedRoutingAnalysis> {
  const {
    questionnaireId,
    versionId,
    adminId,
    clientIp,
    agent,
    input,
    result,
    startedAt,
    log,
    trigger,
  } = params;

  const existingKeys = new Set(input.existingTopics.map((t) => t.key));
  const draft = await saveTopicDraft(
    versionId,
    toProposedSet(result, existingKeys, new Date().toISOString())
  );

  // Which questions the proposal left homeless. Computed here rather than trusted from the model:
  // with scope active a question in no topic can never be asked, and nothing else in the system
  // reports it — so the reviewer is told the number before they accept, not after.
  const covered = new Set(draft.topics.flatMap((t) => t.members.questionKeys));
  const uncoveredQuestionCount = input.questions.filter((q) => !covered.has(q.key)).length;
  const replacedCount = draft.topics.filter((t) => t.replacesExisting).length;

  void recordAiRun({
    subjectKind: 'version',
    subjectId: versionId,
    versionId,
    kind: 'routing_analysis',
    status: 'succeeded',
    provider: agent.provider || 'resolved-at-runtime',
    model: agent.model || 'resolved-at-runtime',
    outputSnapshot: result,
    durationMs: Date.now() - startedAt,
    detail: {
      topicCount: draft.topics.length,
      conditionalCount: draft.topics.filter((t) => t.phase === 'conditional').length,
      ruleCount: draft.rules.length,
      gapCount: draft.gaps.length,
      replacedCount,
      uncoveredQuestionCount,
      fromDocument: draft.fromDocument,
      usedDocument: Boolean(input.documentText),
      trigger,
    },
    triggeredByUserId: adminId,
  });

  logAdminAction({
    userId: adminId,
    action: 'questionnaire_topics.analyse',
    entityType: 'questionnaire_version',
    entityId: versionId,
    metadata: {
      questionnaireId,
      versionId,
      topicCount: draft.topics.length,
      ruleCount: draft.rules.length,
      gapCount: draft.gaps.length,
      fromDocument: draft.fromDocument,
      trigger,
    },
    clientIp,
  });
  log.info('Routing analysed', {
    questionnaireId,
    versionId,
    topicCount: draft.topics.length,
    ruleCount: draft.rules.length,
    gapCount: draft.gaps.length,
    fromDocument: draft.fromDocument,
    uncoveredQuestionCount,
    trigger,
  });

  return { draft, replacedCount, uncoveredQuestionCount };
}

/**
 * How long an ingest may already have run and still afford to propose inline.
 *
 * The routes declare `maxDuration = 300`, which is this deployment's ceiling (seven other routes
 * use it). The analyst is bounded at 180s, so a stream that is already 90 seconds in cannot finish
 * one inside the ceiling — and running it anyway is worse than not running it, because the function
 * is killed mid-`proposing_scope`, the SSE stream dies without a `done` event, and the upload
 * dialog reports "Upload failed" for a questionnaire that was persisted minutes earlier. The admin
 * then retries, paying for the whole pipeline again.
 *
 * Skipping costs nothing but latency: the candidacy verdict is cached on the version, so the Topics
 * tab's auto-trigger proposes on the first visit instead.
 */
export const MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS = 90_000;

/** Whether an ingest that has run this long can still afford an inline proposal. */
export function canProposeDuringIngest(elapsedMs: number): boolean {
  return elapsedMs < MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS;
}

export interface ProposeScopeDuringIngestParams {
  questionnaireId: string;
  versionId: string;
  adminId: string;
  clientIp: string;
  log: RouteLogger;
}

/** What the ingest stream tells the admin it proposed. `null` when nothing was proposed. */
export interface IngestScopeProposal {
  topicCount: number;
  conditionalCount: number;
}

/**
 * Propose conditional topics during a **streaming** ingest, right after the candidacy check said
 * the document describes routing (F17.22 Phase 2).
 *
 * Fail-soft throughout, the same discipline as the candidacy check itself: a missing agent, a
 * provider outage, an unusable reply or a thrown query all resolve to `null`. An upload that
 * completed must never be reported as failed because an optional proposal could not be made — the
 * admin can still press the button on the Topics tab, where failures are reported properly.
 *
 * Deliberately NOT wired into the non-streaming ingest routes: there is no job queue in this repo
 * to hand a 180-second run to, and no plain request should be held open for one. Those keep the
 * lazy tab-visit trigger, which is what `resolveAutoTriggerPending` is for.
 */
export async function proposeScopeDuringIngest(
  params: ProposeScopeDuringIngestParams
): Promise<IngestScopeProposal | null> {
  const { questionnaireId, versionId, adminId, clientIp, log } = params;
  const startedAt = Date.now();

  try {
    // Re-check before proposing, not just before the candidacy call. The candidacy check runs for
    // up to 20 seconds and deliberately RETURNS its verdict while SKIPPING persistence when the
    // version stopped being untouched mid-call — so a `true` verdict is not on its own a licence to
    // write. Without this, the exact race that check protects against (an admin's own analyst draft
    // landing on this version during the upload) ends with `saveTopicDraft` upserting over it.
    if (!(await isEligibleForScopeCandidacy(versionId))) {
      log.info('scope proposal: version was authored while ingesting; leaving it alone', {
        versionId,
      });
      return null;
    }

    const input = await buildRoutingAnalysisInput(questionnaireId, versionId);
    if (!input) {
      log.warn('scope proposal: no analysable version; skipping', { versionId });
      return null;
    }

    const agent = await loadRoutingAnalystAgent();
    if (!agent) {
      log.warn('scope proposal: Routing Analyst agent not seeded; skipping', { versionId });
      return null;
    }

    const outcome = await dispatchRoutingAnalysis({
      versionId,
      adminId,
      agent,
      input,
      startedAt,
      log,
    });
    if (!outcome.ok) return null;

    const persisted = await persistRoutingAnalysis({
      questionnaireId,
      versionId,
      adminId,
      clientIp,
      agent,
      input,
      result: outcome.result,
      startedAt,
      log,
      trigger: 'ingest',
    });

    return {
      topicCount: persisted.draft.topics.length,
      conditionalCount: persisted.draft.topics.filter((t) => t.phase === 'conditional').length,
    };
  } catch (err) {
    log.warn('scope proposal: threw; the upload is unaffected', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
