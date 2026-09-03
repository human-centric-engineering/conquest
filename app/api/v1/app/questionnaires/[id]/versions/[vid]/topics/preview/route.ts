/**
 * Plan preview — Conditional Topics (F17.14).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/preview
 *   Admin-only. Runs the Scope Planner over a **synthetic** opening the author typed and returns
 *   the plan the version's current settings would produce — which topics, which not, and which
 *   layer decided each. Writes nothing: no session, no plan, no draft.
 *
 * ## Why this exists
 *
 * Every other check on this tab is structural — `validateConditionalTopics` says the configuration is
 * well-formed, not what it will *do*. For a feature whose premise is "the model makes a judgement
 * you cannot fully specify in advance", that left the author's only feedback loop a complete
 * interview, run as a respondent, with the answer inferred backwards from what got asked.
 *
 * ## Synthetic, deliberately
 *
 * The author supplies the answers AND the data-slot fills. In a live interview the fills are an
 * extraction FROM the answers, so a hand-set fill is a hypothesis rather than a prediction — the
 * panel says so. The alternative (running the real extractor over the typed answers) would be more
 * faithful and much slower, and it would make the one case worth demonstrating harder rather than
 * easier: a `not_exists` veto fires on an ABSENT fill, and absence is precisely what an author needs
 * to be able to set by hand.
 *
 * ## Why it records no AppAiRun
 *
 * `ai-run/types.ts` is explicit that interactive previews an admin is merely exploring with are not
 * provenance: nobody acts on this verdict, it changes no durable config, and it is not an output
 * anyone would defend to a client. The spend is still visible — `planScope` routes every call
 * through `logCost`, and this route passes a `preview:` reference so those rows stay separable from
 * real interviews.
 *
 * Rate-limited per admin (`scopePreviewLimiter`) on top of the inherited section cap: one reasoning
 * model call per press, on a button meant to be pressed repeatedly.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import {
  planScope,
  readProposedTopicKeys,
  type PlanScopeResult,
  type ScopeAnswer,
} from '@/lib/app/questionnaire/scope/planner';
import type { ScopeFill } from '@/lib/app/questionnaire/scope/types';
import {
  MEMBER_KEY_MAX_LENGTH,
  SCOPE_RATIONALE_MAX_LENGTH,
} from '@/lib/app/questionnaire/scope/types';
import type { PlanPreviewResult } from '@/lib/app/questionnaire/scope/views';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadConditionalTopicsSettings,
  loadTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { loadPlanBudget } from '@/app/api/v1/app/questionnaires/_lib/plan-inputs';
import { scopePreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * How much typed text one synthetic answer may carry.
 *
 * Generous rather than tight: the whole point is to paste in something that reads like a real
 * respondent, and a real respondent's opening answer runs long. The planner's own prompt cap
 * (`MAX_ANSWERS_IN_PLANNER_PROMPT`) is what actually bounds the call.
 */
const PREVIEW_ANSWER_MAX_LENGTH = 4_000;

/**
 * How long a submitted question / data-slot key may be.
 *
 * Deliberately NOT `TOPIC_KEY_MAX_LENGTH`: that bounds a *topic* key, and these are question and
 * data-slot keys, which nothing bounds at 64 — `persist.ts` writes an extracted key straight
 * through, and an imported definition's key is passed through `nextAvailableKey` untruncated. Tying
 * the two together would 400 the whole preview, with a generic "Invalid request body", on a version
 * whose only sin is one long key. Generous here and permissive downstream: a key that resolves to
 * nothing is dropped per item rather than failing the request.
 *
 * This reasoning was right and this route was the only place that had it. It is now
 * {@link MEMBER_KEY_MAX_LENGTH}, shared with the analyst schema, the admin save schema and the
 * read path — all three of which were still borrowing the topic bound, and all three of which broke
 * on one questionnaire because of it. Aliased rather than inlined so the name reads locally.
 */
const PREVIEW_KEY_MAX_LENGTH = MEMBER_KEY_MAX_LENGTH;

const bodySchema = z.object({
  /** What the respondent "said", keyed by opening question. */
  answers: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(PREVIEW_KEY_MAX_LENGTH),
        text: z.string().trim().max(PREVIEW_ANSWER_MAX_LENGTH),
      })
    )
    .max(50)
    .default([]),
  /**
   * What the extractor would have captured. An OMITTED slot is the interesting case — it is what a
   * `not_exists` veto matches on — so the client simply leaves it out rather than sending a blank.
   */
  fills: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(PREVIEW_KEY_MAX_LENGTH),
        paraphrase: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
      })
    )
    .max(50)
    .default([]),
});

const handlePreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, bodySchema);

    const rl = scopePreviewLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Scope preview rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const [settings, topics] = await Promise.all([
      loadConditionalTopicsSettings(vid),
      loadTopics(vid),
    ]);
    if (topics.length === 0) {
      return errorResponse('This version has no topics to plan over', {
        code: 'NO_TOPICS',
        status: 422,
      });
    }

    // The prompt reads each answer WITH the question it answered — "about two years" is not evidence
    // until you know what it was asked about. An answer whose key no longer resolves is dropped
    // rather than printed promptless. The goal rides along for the planner's framing block.
    const [questionRows, version] = await Promise.all([
      prisma.appQuestionSlot.findMany({
        where: { versionId: vid },
        select: { key: true, prompt: true },
      }),
      prisma.appQuestionnaireVersion.findUnique({
        where: { id: vid },
        select: { goal: true },
      }),
    ]);
    const prompts = new Map(questionRows.map((q) => [q.key, q.prompt] as const));
    const answers: ScopeAnswer[] = body.answers.flatMap((a) => {
      const prompt = prompts.get(a.key);
      if (a.text === '' || prompt === undefined) return [];
      return [
        {
          key: a.key,
          prompt,
          value: null,
          // Typed text IS the paraphrase: it is a natural-language account of what they conveyed,
          // which is exactly what the planner prefers over a mapped form code.
          paraphrase: a.text,
        },
      ];
    });

    const fills: ScopeFill[] = body.fills.map((f) => ({
      key: f.key,
      value: null,
      paraphrase: f.paraphrase,
    }));

    const budget = await loadPlanBudget(vid, settings, topics);

    const result = await planScope({
      // Not a session id, and shaped so it cannot be mistaken for one in a cost row or a log line.
      sessionId: `preview:${vid}`,
      topics,
      fills,
      answers,
      goal: version?.goal ?? null,
      settings,
      // A synthetic opening has no turn history. Zero reads as "decided before any turn", which is
      // what a dry-run is, and keeps the announcement's `decidedAtTurn` arithmetic honest.
      decidedAtTurn: 0,
      ...(budget ? { budget } : {}),
    });

    // `outputSnapshot` is the model's own answer before any guardrail touched it. Surfacing the keys
    // is what lets an author tell "the model never picked this" from "the model picked it and the
    // cap/budget took it back" — the two most common questions a preview is opened to answer.
    const proposedKeys = readProposedTopicKeys(result.outputSnapshot);

    const payload: PlanPreviewResult = {
      plan: result.plan,
      proposedKeys,
      skippedModelReason: describeDecision(result, settings.minConfidence),
      costUsd: result.costUsd,
    };

    log.info('Conditional topics plan preview', {
      questionnaireId: id,
      versionId: vid,
      adminId,
      source: result.plan.source,
      confidence: result.plan.confidence,
      selectedCount: result.plan.topics.length,
      costUsd: result.costUsd,
    });

    return successResponse(payload);
  }
);

/**
 * Name the layer that decided, when it was not the agent's judgement.
 *
 * Returns null on the ordinary path (the agent answered and its answer stood), where the per-topic
 * sources already tell the whole story. Every other path needs a sentence, because the plan alone
 * cannot distinguish them and each points the author somewhere different:
 *
 * - **The agent was never called.** `confidence` disambiguates the two ways that happens —
 *   `planScope` records `1` when there was genuinely nothing to choose between (no conditional
 *   topics, or every one already settled by a rule) and `0` when the call itself failed. Telling an
 *   author their planner is unreachable when it is healthy and simply had nothing to do sends them
 *   debugging an agent that is fine.
 * - **The agent answered and was overruled by the confidence floor.** This one has a non-null
 *   provider, so a check on "was a model called" misses it entirely — and it is the most confusing
 *   state to land in unexplained, because the model's own picks are sitting in the excluded list
 *   rationalised as though nothing pointed at them.
 */
function describeDecision(result: PlanScopeResult, minConfidence: number): string | null {
  const { plan } = result;

  if (result.provider === null) {
    if (plan.confidence === 0) {
      return 'The agent could not be reached, so your fallback set applied.';
    }
    return plan.source === 'fallback'
      ? 'There was nothing for the agent to decide — every conditional topic was already settled by your rules — so your fallback set applied.'
      : 'There was nothing for the agent to decide — every conditional topic was already settled by your rules.';
  }

  if (plan.source === 'fallback') {
    return `The agent answered, but its confidence (${Math.round(plan.confidence * 100)}%) was below your floor (${Math.round(minConfidence * 100)}%), so its picks were discarded and your fallback set applied.`;
  }

  return null;
}

export const POST = handlePreview;
