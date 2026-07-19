/**
 * Streaming data-slot generation (map-reduce) — Data Slots feature.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/data-slots/generate/stream
 *   Admin-only SSE endpoint. Fans the version's questions out by section, generates slots per
 *   section in parallel, then merges them into a final set — emitting progress events the whole
 *   way (`start` → `group_done`/`group_error`* → `merge_start` → `done`) so the admin watches
 *   the slots build instead of staring at a spinner. The final set is persisted as the version's
 *   pending DRAFT (AppDataSlotDraft) before the terminal `done` event, exactly like the
 *   single-shot route — runtime + the launch gate still read only the saved set until the admin
 *   reviews + saves. Per-admin sub-cap.
 *
 * The non-streaming sibling (`../generate`) stays for API consumers; the admin UI uses this one.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import {
  DEFAULT_DATA_SLOT_GRANULARITY,
  dataSlotGranularitySchema,
  type DataSlotGenEvent,
  type DataSlotGranularity,
} from '@/lib/app/questionnaire/data-slots';
import {
  streamDataSlotGeneration,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/data-slots/generate-stream';
import {
  buildDataSlotStructure,
  upsertDataSlotDraft,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { dataSlotsGenerationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleGenerateStream = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = dataSlotsGenerationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Data-slots stream generation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    // Granularity from the body (back-compat: missing/invalid → default).
    let granularity: DataSlotGranularity = DEFAULT_DATA_SLOT_GRANULARITY;
    try {
      const parsed = dataSlotGranularitySchema.safeParse(
        ((await request.json()) as { granularity?: unknown } | null)?.granularity
      );
      if (parsed.success) granularity = parsed.data;
    } catch {
      // No JSON body — keep the default.
    }

    const structure = await buildDataSlotStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found or has no questions');
    }

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Data-slot generator agent not found; run db:seed', {
        slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
      });
      throw new NotFoundError('Data-slot generation is not configured');
    }

    // The async generator: forward the orchestrator's progress events, then persist the final
    // set and emit the terminal `done`. Persistence failure is logged, not retro-failed onto the
    // already-streamed response — same contract as the live turn loop.
    async function* drive(): AsyncGenerator<DataSlotGenEvent> {
      const gen = streamDataSlotGeneration({
        structure: structure!,
        granularity,
        agent: {
          provider: agent!.provider,
          model: agent!.model,
          fallbackProviders: agent!.fallbackProviders,
        },
        agentId: agent!.id,
        versionId: vid,
      });

      let fatal = false;
      let result = await gen.next();
      while (!result.done) {
        if (result.value.type === 'error') fatal = true;
        yield result.value;
        result = await gen.next();
      }

      if (fatal) return;

      const finalSlots = result.value;
      let persisted = false;
      if (finalSlots.length > 0) {
        try {
          await upsertDataSlotDraft(vid, finalSlots);
          persisted = true;
        } catch (err) {
          log.error('Data-slots stream: draft persist failed (response already streamed)', {
            questionnaireId: id,
            versionId: vid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info('Data slots generated (stream)', {
        questionnaireId: id,
        versionId: vid,
        slotCount: finalSlots.length,
        granularity,
        persisted,
      });

      yield { type: 'done', slots: finalSlots, persisted };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = handleGenerateStream;
