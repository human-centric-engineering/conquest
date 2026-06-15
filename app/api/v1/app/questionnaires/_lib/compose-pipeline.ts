/**
 * Shared generative-authoring pipeline (compose-from-brief).
 *
 * The "load the composer agent → dispatch a capability → coherence-check" stretch
 * is needed by both the non-streaming compose route (dispatches the single-shot
 * capability) and the streaming route (loads the agent binding for the
 * orchestrator). It lives here as two helpers so both single-source it, mirroring
 * `extract-pipeline.ts`. Each returns a discriminated union: `{ ok: true, … }` or
 * `{ ok: false, response }` carrying a ready-made error `Response`.
 */

import { errorResponse } from '@/lib/api/responses';
import type { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import { QUESTIONNAIRE_COMPOSER_AGENT_SLUG } from '@/lib/app/questionnaire/ingestion/stream-compose';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { AudienceShape, QuestionType } from '@/lib/app/questionnaire/types';
import type { ComposeStructure } from '@/lib/app/questionnaire/ingestion/compose-schema';
import { isRecord } from '@/lib/utils';
import {
  assertPersistable,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

type RouteLogger = Awaited<ReturnType<typeof getRouteLogger>>;
type PipelineResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/** The provider-agnostic binding the orchestrator / capability dispatch needs. */
export interface ComposerAgent {
  id: string;
  provider: string;
  model: string;
  fallbackProviders: string[];
}

/** Admin-supplied goal/audience for a compose request (from the JSON body). */
export interface ComposeAdminMeta {
  goal?: string;
  audience?: Partial<AudienceShape>;
}

/** Load the seeded composer agent (provider-agnostic binding + cost attribution). */
export async function loadComposerAgent(log: RouteLogger): Promise<PipelineResult<ComposerAgent>> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    log.error('Questionnaire composer agent not seeded; run db:seed', {
      slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
    });
    return {
      ok: false,
      response: errorResponse('The questionnaire composer is not configured', {
        code: 'COMPOSER_NOT_CONFIGURED',
        status: 503,
      }),
    };
  }
  return { ok: true, value: agent };
}

/** Map a capability dispatch error code to an HTTP status (mirrors extract-pipeline). */
function dispatchErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'invalid_args':
      return 400;
    case 'no_provider_configured':
    case 'provider_unavailable':
    case 'capability_inactive':
    case 'capability_disabled_for_agent':
    case 'unknown_capability':
    case 'capability_quarantined':
    case 'requires_approval':
      return 503;
    default:
      return 502;
  }
}

function dispatchErrorCode(status: number): string {
  if (status === 429) return 'COMPOSER_RATE_LIMITED';
  if (status === 400) return 'INVALID_COMPOSE_ARGS';
  if (status === 503) return 'COMPOSER_UNAVAILABLE';
  return 'COMPOSITION_FAILED';
}

/**
 * Dispatch the single-shot compose capability for a brief, then run the coherence
 * pre-check (every question must map to a declared section). Returns the validated
 * structure or a ready-made error `Response`. The non-streaming compose route uses
 * this; the streaming route drives the orchestrator instead.
 */
export async function composeFromBrief(
  agent: ComposerAgent,
  input: { brief: string; adminMeta: ComposeAdminMeta; adminId: string },
  log: RouteLogger
): Promise<PipelineResult<ExtractQuestionnaireStructureData>> {
  const { brief, adminMeta, adminId } = input;

  // Flush the built-in + app capability handlers into the dispatcher before
  // dispatching — compose may be the first capability touch on a fresh process.
  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
    {
      brief,
      ...(adminMeta.goal !== undefined ? { adminProvidedGoal: adminMeta.goal } : {}),
      ...(adminMeta.audience !== undefined ? { adminProvidedAudience: adminMeta.audience } : {}),
    },
    {
      userId: adminId,
      agentId: agent.id,
      entityContext: {
        composerAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success || !dispatch.data) {
    const status = dispatchErrorStatus(dispatch.error?.code);
    log.warn('Questionnaire composition failed', {
      adminId,
      capabilityError: dispatch.error?.code,
      status,
    });
    return {
      ok: false,
      response: errorResponse(dispatch.error?.message ?? 'Composition failed', {
        code: dispatchErrorCode(status),
        status,
        ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
      }),
    };
  }

  const extraction = dispatch.data as ExtractQuestionnaireStructureData;

  try {
    assertPersistable(extraction);
  } catch (err) {
    if (err instanceof IncoherentExtractionError) {
      log.warn('Questionnaire composition incoherent', {
        adminId,
        orphanSectionOrdinals: err.orphanSectionOrdinals,
      });
      return {
        ok: false,
        response: errorResponse(err.message, {
          code: 'COMPOSITION_INCOHERENT',
          status: 422,
          details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
        }),
      };
    }
    throw err;
  }

  return { ok: true, value: extraction };
}

/**
 * Load a draft version's current graph as a {@link ComposeStructure} for the
 * conversational-refine turn, enforcing the safety guards: the version must exist
 * under the given questionnaire, be a **draft**, and have **no respondent
 * sessions** (a refine never rewrites a launched/in-flight graph). Returns the
 * structure or a ready-made error `Response` (404 / 409).
 */
export async function loadRefinableStructure(
  questionnaireId: string,
  versionId: string
): Promise<PipelineResult<ComposeStructure>> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      questionnaireId: true,
      status: true,
      goal: true,
      audience: true,
      _count: { select: { sessions: true } },
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          ordinal: true,
          title: true,
          description: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              key: true,
              prompt: true,
              type: true,
              typeConfig: true,
              guidelines: true,
              rationale: true,
              extractionConfidence: true,
            },
          },
        },
      },
    },
  });

  if (!version || version.questionnaireId !== questionnaireId) {
    return {
      ok: false,
      response: errorResponse('Questionnaire version not found', {
        code: 'NOT_FOUND',
        status: 404,
      }),
    };
  }
  if (version.status !== 'draft') {
    return {
      ok: false,
      response: errorResponse('Only a draft version can be refined', {
        code: 'REFINE_REQUIRES_DRAFT',
        status: 409,
      }),
    };
  }
  if (version._count.sessions > 0) {
    return {
      ok: false,
      response: errorResponse('This version has respondent sessions and cannot be refined', {
        code: 'REFINE_HAS_SESSIONS',
        status: 409,
      }),
    };
  }

  const structure: ComposeStructure = {
    sections: version.sections.map((s) => ({
      ordinal: s.ordinal,
      title: s.title,
      ...(s.description !== null ? { description: s.description } : {}),
    })),
    questions: version.sections.flatMap((s) =>
      s.questions.map((q) => ({
        sectionOrdinal: s.ordinal,
        key: q.key,
        prompt: q.prompt,
        suggestedType: q.type as QuestionType,
        // Neutral confidence — existing questions carry no fresh extraction score.
        extractionConfidence: q.extractionConfidence ?? 1,
        ...(isRecord(q.typeConfig) ? { suggestedTypeConfig: q.typeConfig } : {}),
        ...(q.guidelines !== null ? { guidelines: q.guidelines } : {}),
        ...(q.rationale !== null ? { rationale: q.rationale } : {}),
      }))
    ),
    ...(version.goal !== null ? { inferredGoal: version.goal } : {}),
    ...(isRecord(version.audience) ? { inferredAudience: version.audience } : {}),
  };

  return { ok: true, value: structure };
}
