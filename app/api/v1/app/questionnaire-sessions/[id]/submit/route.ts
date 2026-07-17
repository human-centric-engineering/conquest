/**
 * Respondent session submission (F7.3).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/submit
 *   → { success: true, data: { sessionId, status: 'completed' } }
 *
 * The respondent's accept of the completion offer: transitions `active → completed` and
 * writes the `completed` event. This is the ONLY path that completes a live session — the
 * agent streams an offer ("Would you like to submit?"), the UI shows a Submit affordance
 * when `GET …/status` reports `completion.kind === 'offer'`, and this route records the
 * acceptance. Serves both respondent kinds (authenticated owner + no-login anonymous).
 *
 * The gate reuses the F4.5 pure resolver: it re-asserts the session is genuinely in an
 * `offer` state (a stale/forged client can't submit an ineligible session). A required
 * question can't be outstanding here: `assessCompletion` only returns `offer` once the
 * required gate is clear (the sole exception being a question-cap-reached session, the
 * existing F4.5 "a capped session can always submit" behaviour, honoured as-is).
 *
 * Once eligible, a **final contradiction sweep** runs over all answers before the session
 * completes (a report built on contradictory data would mislead — see contradiction-detection.md).
 * A surviving conflict HOLDS the submit (`{ held: true, probe }`) instead of completing; the
 * respondent reconciles it in the chat (or a final-check modal on the early-finish path) and finishes
 * again, or bypasses via `{ skipSweep: true }`. The sweep consults the ledger so it never re-nags
 * about a conflict already dealt with mid-conversation, and is fail-soft (any error → completes).
 *
 * Gate order: live-sessions flag (404 before auth) → load → access (401/403) → status
 * (idempotent on already-completed; 409 on paused/abandoned) → offer-eligibility (409) →
 * final sweep (held or clean) → transition.
 */

import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, handleAPIError } from '@/lib/api/errors';
import { Prisma } from '@prisma/client';

import {
  assessCompletion,
  resolveCompletion,
} from '@/lib/app/questionnaire/completion/completion-logic';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  buildContradictionProbe,
  buildContradictionNoticeMessage,
  filterSweepFindings,
} from '@/lib/app/questionnaire/contradiction';
import type {
  ContradictionFinding,
  PendingContradiction,
} from '@/lib/app/questionnaire/contradiction/types';
import {
  questionProbeLabels,
  raisedEntry,
} from '@/lib/app/questionnaire/orchestrator/contradiction-phase';
import { DETECT_CONTRADICTIONS_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { turnLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { runCompletionSweep } from '@/app/api/v1/app/questionnaire-sessions/_lib/completion-sweep-run';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { markSessionCompleted } from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { recordTurn } from '@/app/api/v1/app/questionnaires/_lib/turns';
import { enqueueRespondentReport } from '@/lib/app/questionnaire/report/enqueue';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';
import { refreshRoundLearningDigest } from '@/lib/app/questionnaire/learning/digest';

/**
 * Cap the post-response work scheduled via `after()`. On serverless this is bounded by the
 * function's `maxDuration` (60s, set below); the value documents intent for readers.
 */
export const maxDuration = 60;

/**
 * Optional submit body. Absent (the standard "accept the agent's offer" submit) ⇒ `early: false`.
 * `{ early: true }` is the respondent-controlled early-finish escape hatch (bypasses the gate when
 * `assessCompletion` reports `earlyFinishAvailable`). `strict()` rejects stray keys.
 */
const submitBodySchema = z
  .object({
    early: z.boolean().optional(),
    /**
     * "Submit / get my report anyway" — bypass the final contradiction sweep. Set by the client when
     * the respondent chooses to finish despite the final-check probe (the sweep already surfaced the
     * conflict once; this is the escape hatch so they are never trapped). Absent ⇒ the sweep runs.
     */
    skipSweep: z.boolean().optional(),
  })
  .strict();

/**
 * Reconstruct the conflict list from a parked {@link PendingContradiction} so the probe text can be
 * rebuilt deterministically (for the short-circuit re-surface). Uses the per-conflict `findings` when
 * present (a combined probe), else the single legacy conflict. Confidence/severity are placeholders —
 * `buildContradictionProbe` only reads slotKeys/explanation/suggestedProbe.
 */
function pendingToFindings(pending: PendingContradiction): ContradictionFinding[] {
  const list =
    pending.findings && pending.findings.length > 0
      ? pending.findings
      : [
          {
            slotKeys: pending.slotKeys,
            explanation: pending.explanation,
            ...(pending.suggestedProbe !== undefined
              ? { suggestedProbe: pending.suggestedProbe }
              : {}),
          },
        ];
  return list.map((f) => ({
    slotKeys: f.slotKeys,
    explanation: f.explanation,
    severity: 'medium' as const,
    confidence: 1,
    ...(f.suggestedProbe !== undefined ? { suggestedProbe: f.suggestedProbe } : {}),
  }));
}

async function handleSubmit(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // Body is optional — the standard submit sends none; early finish sends `{ early: true }`, and the
    // final-check escape hatch sends `{ skipSweep: true }`.
    let early = false;
    let skipSweep = false;
    const rawBody = await request.text();
    if (rawBody.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return errorResponse('Invalid JSON in request body', {
          code: 'VALIDATION_ERROR',
          status: 400,
        });
      }
      const result = submitBodySchema.safeParse(parsed);
      if (!result.success) {
        return errorResponse('Invalid request body', { code: 'VALIDATION_ERROR', status: 400 });
      }
      early = result.data.early ?? false;
      skipSweep = result.data.skipSweep ?? false;
    }

    const loaded = await buildTurnContext(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Already completed → idempotent success (a double-submit / network race lands here).
    if (loaded.session.status === 'completed') {
      return successResponse({ sessionId, status: 'completed' as const });
    }
    // Paused/abandoned can't submit directly — the state machine forbids it (paused must
    // resume first). Surface a clean 409 rather than relying on the transition throw.
    if (loaded.session.status !== 'active') {
      return errorResponse(`Session is ${loaded.session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    // Re-assert eligibility through the F4.5 resolver — no sweep (contradictions surface live).
    const assessment = assessCompletion({
      questions: loaded.base.questions,
      answered: loaded.base.answered,
      config: loaded.base.config,
      sessionId: loaded.base.sessionId,
    });
    const resolution = resolveCompletion(early ? 'finish_early' : 'accept', assessment, {
      run: false,
      contradictionCount: 0,
    });
    if (resolution.kind !== 'submit') {
      log.info('Submit refused — session not ready', {
        sessionId,
        completion: assessment.kind,
        early,
        earlyFinishAvailable: assessment.earlyFinishAvailable,
      });
      return errorResponse(resolution.rationale, { code: 'SUBMIT_NOT_READY', status: 409 });
    }

    // Final contradiction check — the last chance to catch conflicting answers before the session
    // completes and its report is generated (a report built on contradictory data would mislead).
    // Runs for BOTH normal submit and early finish; skipped when the respondent chose to finish anyway
    // (`skipSweep`). On a held conflict we DON'T complete: park a combined probe, record it as a turn
    // (so it shows in the chat / a final-check modal and replays on resume), and return `held` so the
    // client can offer "clarify" or "finish anyway".
    const labels = questionProbeLabels(loaded.base.questions);
    const heldResponse = (
      findings: ContradictionFinding[],
      probeText: string,
      slotKeys: string[]
    ) =>
      successResponse({
        sessionId,
        status: 'active' as const,
        held: true as const,
        probe: { text: probeText, slotKeys },
        // The notice message the client renders as the "I noticed something" box beneath the probe —
        // returned so the live transcript matches the persisted turn's warning exactly (no reload gap).
        notice: buildContradictionNoticeMessage(findings),
        early,
      });

    if (!skipSweep) {
      // Short-circuit: a probe is ALREADY parked (a prior hold, or a per-turn probe the respondent
      // finished over). Re-surface THAT probe — no re-sweep (no LLM), no duplicate turn — so a
      // resume-then-resubmit is idempotent rather than spamming the transcript and burning tokens.
      const existingPending = loaded.base.pendingContradiction;
      if (existingPending) {
        const findings = pendingToFindings(existingPending);
        const { text } = buildContradictionProbe({
          findings,
          statement: existingPending.statement,
          raisedAtTurnIndex: existingPending.raisedAtTurnIndex,
          labels,
          dataMode: false,
        });
        log.info('Submit re-held on an already-parked contradiction', { sessionId, early });
        return heldResponse(findings, text, existingPending.slotKeys);
      }

      const mode = loaded.base.config.contradictionMode;
      if (mode !== 'off') {
        // Per-flow sub-cap on the paid sweep — checked only on the path that actually dispatches the
        // detector LLM (mirrors the messages route's per-turn guard), so a held session can't be
        // re-POSTed to hammer detection.
        const limit = turnLimiter.check(access.rateKey);
        if (!limit.success) return createRateLimitResponse(limit);

        const { findings, costUsd } = await runCompletionSweep({
          sessionId,
          userId: access.userId,
          slots: loaded.slots,
          answers: loaded.base.existingAnswers,
          mode,
        });
        const survivors = filterSweepFindings(findings, loaded.base.raisedContradictions ?? []);
        if (survivors.length > 0) {
          const { text, pending } = buildContradictionProbe({
            findings: survivors,
            statement: '', // no triggering message at submit — the sweep compares stored answers
            raisedAtTurnIndex: loaded.base.selectionRound,
            labels,
            dataMode: false,
          });
          // Record each surfaced conflict as `unresolved` (deduped against the existing ledger), so the
          // per-turn pass doesn't re-probe it and a "finish anyway" leaves an honest audit trail.
          const existing = loaded.base.raisedContradictions ?? [];
          const existingKeys = new Set(existing.map((r) => r.key));
          const ledger = [
            ...existing,
            ...survivors
              .map((f) => raisedEntry(f, 'unresolved', loaded.base.selectionRound))
              .filter((e) => !existingKeys.has(e.key)),
          ];

          // Park the probe + ledger BEFORE recording the turn, so a mid-write crash can't strand a
          // recorded probe with no pending state to resolve it. The respondent's next chat message
          // resolves it through the normal messages-endpoint resolution turn (refining answers + data
          // slots in the background), after which a re-submit finds it dealt-with and completes.
          await prisma.appQuestionnaireSession.update({
            where: { id: sessionId },
            data: {
              pendingContradiction: pending as unknown as Prisma.InputJsonValue,
              raisedContradictions: ledger as unknown as Prisma.InputJsonValue,
            },
          });
          await recordTurn({
            sessionId,
            userMessage: '',
            agentResponse: text,
            targetedQuestionId: null,
            toolCalls: [{ slug: DETECT_CONTRADICTIONS_CAPABILITY_SLUG, success: true }],
            sideEffectAnswerIds: [],
            warnings: [
              { code: 'contradiction', message: buildContradictionNoticeMessage(survivors) },
            ],
            costUsd,
          });

          log.info('Submit held for final contradiction check', {
            sessionId,
            early,
            conflicts: survivors.length,
          });
          return heldResponse(survivors, text, pending.slotKeys);
        }
      }
    }

    // Completing: clear any parked probe first — a "finish anyway" (skipSweep) reaches here with a
    // pending contradiction still on the row, and a completed session must not carry a stale probe.
    if (loaded.base.pendingContradiction) {
      await prisma.appQuestionnaireSession.update({
        where: { id: sessionId },
        data: { pendingContradiction: Prisma.DbNull },
      });
    }

    try {
      const status = await markSessionCompleted(sessionId, {
        reason: early ? 'respondent_early_finish' : 'respondent_submit',
      });
      log.info('Respondent session submitted', { sessionId, status, early });
      // Queue the respondent report when the version is configured for an AI mode (raw_plus_insights
      // or narrative). Best-effort — a queue failure must never fail the submission just made.
      const enqueued = await enqueueRespondentReport(sessionId).catch((err) => {
        log.error('Failed to enqueue respondent report', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });
      // Instant start: kick the report worker AFTER the response so generation begins within
      // seconds rather than waiting for the next maintenance-cron minute. `after()` (next/server)
      // survives serverless (runs within the function's maxDuration) and on a persistent process
      // alike — unlike a bare `void`, which Vercel freezes. The worker claims via a lease, so this
      // kick and the scheduled cron drain can never double-process the same report. The cron
      // remains the backstop if this kick is cut off mid-generation.
      if (enqueued) {
        after(async () => {
          try {
            await processQueuedRespondentReports();
          } catch (err) {
            log.error('Respondent report kick failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
      // Learning Mode: rebuild this round's peer-theme digest so the NEXT respondent sees the
      // just-completed session folded in. Gated by the platform flag + the round having a roundId;
      // the builder itself re-checks the per-round toggle + k-anonymity. Runs via `after()` so it
      // never blocks THIS respondent's submit confirmation behind an LLM call that only benefits
      // the next respondent, yet still completes on serverless (a bare `void` would be frozen).
      // A missed rebuild self-heals on the next completion (or a manual admin Rebuild). Fail-soft.
      if (loaded.session.roundId) {
        const roundId = loaded.session.roundId;
        after(() =>
          refreshRoundLearningDigest(roundId, loaded.session.versionId).catch((err) => {
            log.error('Failed to refresh round learning digest', {
              sessionId,
              roundId,
              error: err instanceof Error ? err.message : String(err),
            });
          })
        );
      }
      return successResponse({ sessionId, status });
    } catch (err) {
      if (err instanceof SessionTransitionError) {
        throw new ConflictError(err.message, { from: err.from, to: err.to });
      }
      throw err;
    }
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleSubmit;
