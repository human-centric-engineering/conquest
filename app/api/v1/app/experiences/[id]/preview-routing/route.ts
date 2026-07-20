/**
 * Routing dry-run (P15.2).
 *
 * POST /api/v1/app/experiences/:id/preview-routing  { sessionId }
 *
 * Runs the full three-tier resolution — rules, then the selector, then the fallback — against a
 * real completed session, and returns the decision WITHOUT creating a leg, touching a run, or
 * changing anything. Lets an author see what their criteria and instructions actually produce
 * before a respondent meets them.
 *
 * `withAdminAuth`. Records an `AppAiRun` like a live decision does, because a dry run is exactly
 * the calibration signal the provenance table exists to accumulate — and because an author
 * comparing two phrasings of a criterion wants both attempts on the record.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';

import { previewRoutingSchema } from '@/lib/app/questionnaire/experiences/schemas';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import { EXPERIENCE_ROUTING_FALLBACKS } from '@/lib/app/questionnaire/experiences/types';
import { buildCarryOver } from '@/lib/app/questionnaire/experiences/carryover/build';
import { evaluateRoutingRules } from '@/lib/app/questionnaire/experiences/routing/rules';
import { selectNextStep } from '@/lib/app/questionnaire/experiences/routing/select';
import { routeDecision } from '@/lib/app/questionnaire/experiences/routing/fallback';
import {
  ROUTING_RULE_OPERATORS,
  type CandidateStep,
  type RoutingRule,
} from '@/lib/app/questionnaire/experiences/routing/types';

const handlePreview = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: {
      id: true,
      routingFallback: true,
      minRoutingConfidence: true,
      routingInstructions: true,
      settings: true,
      steps: {
        orderBy: { ordinal: 'asc' },
        select: {
          key: true,
          kind: true,
          title: true,
          purpose: true,
          selectionCriteria: true,
          ordinal: true,
          questionnaireId: true,
        },
      },
      routingRules: { orderBy: { ordinal: 'asc' } },
    },
  });
  if (!experience) throw new NotFoundError('Experience not found');

  const body = await validateRequestBody(request, previewRoutingSchema);

  const subject = await prisma.appQuestionnaireSession.findUnique({
    where: { id: body.sessionId },
    select: { id: true, status: true },
  });
  if (!subject) {
    return errorResponse('That session does not exist', { code: 'NOT_FOUND', status: 404 });
  }
  // A live session's answers are still moving, so a decision made against them would not be
  // reproducible — which is the whole point of a dry run.
  if (subject.status !== 'completed') {
    return errorResponse('Choose a completed session — a live one is still changing', {
      code: 'SESSION_NOT_COMPLETE',
      status: 409,
    });
  }

  const settings = narrowExperienceSettings(experience.settings);
  const candidates: CandidateStep[] = experience.steps
    .filter((s) => s.kind === 'branch' && s.questionnaireId !== null)
    .map((s) => ({
      stepKey: s.key,
      title: s.title,
      purpose: s.purpose,
      selectionCriteria: s.selectionCriteria,
      ordinal: s.ordinal,
    }));

  // Deterministic layer only: the summarisation pass exists to write a bridging line for a
  // respondent who is actually continuing, and spending on it for a dry run would be waste.
  const { context } = await buildCarryOver({
    sessionId: body.sessionId,
    fromStepKey: 'preview',
    carryProfile: settings.carryProfile,
    summarise: false,
    next: null,
  });

  const rules: RoutingRule[] = experience.routingRules.map((r) => ({
    id: r.id,
    dataSlotKey: r.dataSlotKey,
    operator: narrowToEnum(r.operator, ROUTING_RULE_OPERATORS, 'equals'),
    value: r.value,
    targetStepKey: r.targetStepKey,
    ordinal: r.ordinal,
  }));

  const ruleTarget = evaluateRoutingRules(
    rules,
    context.fills,
    candidates.map((c) => c.stepKey)
  );

  const result = ruleTarget
    ? {
        decision: routeDecision(
          ruleTarget,
          `Matched a routing rule targeting "${ruleTarget}".`,
          'rule' as const
        ),
        costUsd: 0,
        provider: null,
        model: null,
        promptSnapshot: null,
        outputSnapshot: null,
      }
    : await selectNextStep({
        experienceId: experience.id,
        candidates,
        carryOver: context,
        routingInstructions: experience.routingInstructions,
        fallback: narrowToEnum(
          experience.routingFallback,
          EXPERIENCE_ROUTING_FALLBACKS,
          'conclude'
        ),
        minConfidence: experience.minRoutingConfidence,
        defaultStepKey: candidates[0]?.stepKey ?? null,
      });

  void recordAiRun({
    subjectKind: 'experience_run',
    // No run exists for a dry run, so the subject is the experience being tuned — which is also
    // what an author filtering their calibration history would search by.
    subjectId: experience.id,
    kind: 'experience_routing',
    status: 'succeeded',
    provider: result.provider ?? 'deterministic',
    model: result.model ?? 'deterministic',
    promptSnapshot: result.promptSnapshot,
    outputSnapshot: result.outputSnapshot,
    costUsd: result.costUsd,
    triggeredByUserId: session.user.id,
    detail: {
      preview: true,
      subjectSessionId: body.sessionId,
      source: result.decision.source,
      decision: result.decision.decision,
      selectedStepKey: result.decision.selectedStepKey,
      confidence: result.decision.confidence,
      candidateKeys: candidates.map((c) => c.stepKey),
    },
  });

  log.info('Routing dry-run', {
    experienceId: id,
    sessionId: body.sessionId,
    source: result.decision.source,
    decision: result.decision.decision,
  });

  return successResponse({
    decision: result.decision,
    costUsd: result.costUsd,
    // The fills the decision was made from, so an author can see WHY — a decision without its
    // inputs is not something you can tune against.
    carriedFills: context.fills.map((f) => ({
      key: f.key,
      name: f.name,
      paraphrase: f.paraphrase,
      confidence: f.confidence,
    })),
    candidateKeys: candidates.map((c) => c.stepKey),
  });
});

export const POST = handlePreview;
