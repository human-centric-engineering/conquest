/**
 * Questionnaire completion action (F4.5).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/complete
 *   body: {
 *     action: 'accept' | 'hold'
 *     answers: { key: string; value: unknown; confidence?: number | null;
 *                provenance?: AnswerProvenance; turnIndex?: number }[]
 *     mode?:    'off' | 'flag' | 'probe'   // completion-sweep override; default = config
 *     windowN?: number
 *     sessionId?: string
 *   }
 *
 *   Admin-only. Resolves the respondent's accept / hold against the deterministic
 *   completion gate and — unlike the read-only `completion-status` route — PERSISTS:
 *   it seeds the supplied answers into a per-version **preview session** (`isPreview`,
 *   excluded from P8 analytics), and on a successful submit transitions the session
 *   `active → completed`.
 *
 *   On `accept`, when the gate says we may offer, it drives the F4.3 contradiction
 *   **completion-sweep** (`shouldRunDetection(mode, windowN, 'completion-sweep')`)
 *   over the supplied answers. A clean (or skipped/disabled) sweep submits; a sweep
 *   that finds contradictions HOLDS FOR REVIEW — the session stays `active`, the
 *   findings come back for reconciliation (F4.4), and nothing is auto-submitted.
 *   `accept` while the gate is not an offer (e.g. a required question is open) does
 *   NOT submit. `hold` always continues.
 *
 *   The sweep takes a per-admin sub-cap and is fail-soft (a failed sweep is treated
 *   as clean so a wrap-up never 5xxs).
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  ANSWER_PROVENANCES,
  CONTRADICTION_MODES,
  type AnswerProvenance,
} from '@/lib/app/questionnaire/types';
import {
  assessCompletion,
  resolveCompletion,
  COMPLETION_ACTIONS,
  type CompletionSweepResult,
} from '@/lib/app/questionnaire/completion';
import { shouldRunDetection } from '@/lib/app/questionnaire/contradiction';
import {
  MAX_CONTRADICTION_ANSWERS,
  MAX_CONTRADICTION_SLOTS,
  type DetectContradictionsData,
} from '@/lib/app/questionnaire/capabilities';
import { buildSelectionContext } from '@/app/api/v1/app/questionnaires/_lib/selection-context';
import { buildContradictionContext } from '@/app/api/v1/app/questionnaires/_lib/contradiction-context';
import {
  getOrCreatePreviewSession,
  markSessionCompleted,
  upsertAnswerSlot,
} from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import { completionLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  action: z.enum(COMPLETION_ACTIONS),
  answers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.unknown(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        provenance: z.enum(ANSWER_PROVENANCES).optional(),
        turnIndex: z.number().int().optional(),
      })
    )
    .max(10_000),
  mode: z.enum(CONTRADICTION_MODES).optional(),
  windowN: z.number().int().min(0).max(10_000).optional(),
  sessionId: z.string().max(200).optional(),
});

const handleComplete = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);

    const built = await buildSelectionContext(id, vid, {
      answered: body.answers.map((a) => ({ key: a.key, confidence: a.confidence ?? null })),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
    if (!built) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { context } = built;
    const assessment = assessCompletion(context);

    // Seed the supplied answers into the per-version preview session (idempotent), so
    // both paths leave a faithful snapshot and submit has real rows. slotKey → id from
    // the selection context (which carries every slot's id).
    const slotIdByKey = new Map<string, string>();
    for (const q of context.questions) slotIdByKey.set(q.key, q.id);

    const previewSessionId = await getOrCreatePreviewSession(vid);
    for (const answer of body.answers) {
      const slotId = slotIdByKey.get(answer.key);
      if (!slotId) continue;
      const provenance: AnswerProvenance = answer.provenance ?? 'direct';
      await upsertAnswerSlot(previewSessionId, slotId, {
        value: answer.value,
        provenance,
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      });
    }

    // Run the completion-sweep only on an eligible accept. The decision to run is pure
    // (shouldRunDetection) and execution is fail-soft.
    let sweep: CompletionSweepResult = { run: false, contradictionCount: 0 };
    let diagnostic: string | undefined;
    let findings: DetectContradictionsData['findings'] = [];

    if (body.action === 'accept' && assessment.kind === 'offer') {
      const sweepBuilt = await buildContradictionContext(id, vid, {
        answers: body.answers.map((a) => ({
          key: a.key,
          value: a.value,
          confidence: a.confidence ?? null,
          ...(a.provenance !== undefined ? { provenance: a.provenance } : {}),
          ...(a.turnIndex !== undefined ? { turnIndex: a.turnIndex } : {}),
        })),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.windowN !== undefined ? { windowN: body.windowN } : {}),
        sessionId: previewSessionId,
      });

      // `insufficient_answers` (fewer than two resolvable answers) → nothing can
      // contradict, so the sweep is a no-op clean. `version_not_found` can't happen
      // here (buildSelectionContext already resolved it).
      if (sweepBuilt.ok) {
        const decision = shouldRunDetection(
          sweepBuilt.context.mode,
          sweepBuilt.context.windowN,
          'completion-sweep'
        );
        if (decision.run) {
          // The detector only reasons over slots that carry an answer — an unanswered
          // slot has nothing to compare and is never rendered into the prompt. Trim the
          // version's full slot set to just the answered ones so the detector's
          // MAX_CONTRADICTION_SLOTS cap tracks the answer count, not the questionnaire's
          // size; otherwise a large version with a modest answer set would blow the cap
          // and fail-soft-submit unswept.
          const answeredKeys = new Set(sweepBuilt.context.answers.map((a) => a.slotKey));
          const sweepSlots = sweepBuilt.context.slots.filter((s) => answeredKeys.has(s.key));

          // If even the trimmed input exceeds the detector's hard caps, the sweep can't
          // run — make that explicit (a named diagnostic + a warn) rather than letting a
          // doomed dispatch fail-soft into a silent "clean" submit.
          if (
            sweepSlots.length > MAX_CONTRADICTION_SLOTS ||
            sweepBuilt.context.answers.length > MAX_CONTRADICTION_ANSWERS
          ) {
            diagnostic = 'sweep_skipped_oversized';
            log.warn('Completion sweep skipped: input exceeds detector caps', {
              questionnaireId: id,
              versionId: vid,
              slotCount: sweepSlots.length,
              answerCount: sweepBuilt.context.answers.length,
              maxSlots: MAX_CONTRADICTION_SLOTS,
              maxAnswers: MAX_CONTRADICTION_ANSWERS,
            });
          } else {
            // Per-admin sub-cap on the paid sweep — checked only on the path that
            // actually dispatches the F4.3 LLM call, so a free `hold` or an ineligible
            // `accept` never burns the budget (matching the completion-status route,
            // which shares this limiter and gates it the same way).
            const rl = completionLimiter.check(adminId);
            if (!rl.success) {
              log.warn('Completion rate limit exceeded', { adminId, reset: rl.reset });
              return createRateLimitResponse(rl);
            }

            const agent = await prisma.aiAgent.findUnique({
              where: { slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG },
              select: { id: true, provider: true, model: true, fallbackProviders: true },
            });
            if (!agent) {
              log.error('Contradiction-detector agent not found; run db:seed', {
                slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
              });
              throw new NotFoundError('Contradiction detection is not configured');
            }

            // Flush capability handlers before dispatch — this route may be the first capability
            // touch on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot.
            registerBuiltInCapabilities();

            const dispatch = await capabilityDispatcher.dispatch(
              DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
              {
                slots: sweepSlots,
                answers: sweepBuilt.context.answers,
                mode: sweepBuilt.context.mode,
                windowN: sweepBuilt.context.windowN,
                sessionId: previewSessionId,
              },
              {
                userId: adminId,
                agentId: agent.id,
                entityContext: {
                  contradictionDetectorAgent: {
                    provider: agent.provider,
                    model: agent.model,
                    fallbackProviders: agent.fallbackProviders,
                  },
                },
              }
            );

            if (dispatch.success && dispatch.data) {
              findings = (dispatch.data as DetectContradictionsData).findings;
              sweep = { run: true, contradictionCount: findings.length };
            } else {
              // Fail-soft: a failed sweep counts as clean so a wrap-up never 5xxs.
              diagnostic = dispatch.error?.code ?? 'detection_failed';
              sweep = { run: true, contradictionCount: 0 };
              log.warn('Completion sweep failed; treating as clean', {
                questionnaireId: id,
                versionId: vid,
                code: dispatch.error?.code,
              });
            }
          }
        }
      }
    }

    const resolution = resolveCompletion(body.action, assessment, sweep);

    // Persist the transition only on a clean submit. hold_for_review / continue leave
    // the session active (idempotent — re-completing a completed session is a no-op).
    let status = 'active';
    if (resolution.kind === 'submit') {
      status = await markSessionCompleted(previewSessionId);
    }

    log.info('Questionnaire completion action', {
      questionnaireId: id,
      versionId: vid,
      sessionId: previewSessionId,
      action: body.action,
      assessmentKind: assessment.kind,
      resolution: resolution.kind,
      sweepRun: sweep.run,
      contradictionCount: sweep.contradictionCount,
      status,
    });

    return successResponse({
      assessment,
      resolution,
      sessionId: previewSessionId,
      status,
      ...(findings.length > 0 ? { findings } : {}),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    });
  }
);

export const POST = handleComplete;
