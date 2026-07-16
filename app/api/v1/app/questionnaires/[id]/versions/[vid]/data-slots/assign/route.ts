/**
 * Assign newly-added (orphaned) questions to data slots — Data Slots feature.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/data-slots/assign
 *   body (optional): { questionKeys?: string[] } — restrict to these keys; default = all orphans.
 *
 *   Admin-only. A question added after the slots were generated is covered by no slot ("orphaned").
 *   This runs the assign agent to place each orphan into an existing slot (same data point) or a new
 *   one, then writes the updated set LIVE via `replaceDataSlots` (forking a launched version first,
 *   like every authoring edit). Existing slots are preserved verbatim — they only gain question
 *   keys; the deterministic merge does the writing, the model only decides placement.
 *
 *   Gated by the master flag AND the data-slots sub-flag (paid LLM work). Per-admin sub-cap.
 *   Fail-soft: an agent failure returns the unchanged slots + a diagnostic rather than a 5xx —
 *   the question is already created; failing to slot it must not surface as an error.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  ASSIGN_DATA_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { mergeAssignments, type AssignableSlot } from '@/lib/app/questionnaire/data-slots';
import type { AssignDataSlotsData } from '@/lib/app/questionnaire/capabilities';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  buildDataSlotStructure,
  loadDataSlots,
  replaceDataSlots,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { dataSlotsAssignLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const requestSchema = z.object({
  /** Restrict the assignment to these (newly-added) question keys; omit to assign every orphan. */
  questionKeys: z.array(z.string().min(1)).max(200).optional(),
});

const handleAssign = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = dataSlotsAssignLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Data-slot assign rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorResponse('Invalid assign request', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: parsed.error.issues },
      });
    }
    const requestedKeys = parsed.data.questionKeys;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Fork-if-launched first (keys + slots copy 1:1), then operate entirely on the editable version.
    const fork = await forkVersionIfLaunched(scoped, { userId: adminId, clientIp });
    const editId = fork.versionId;

    const [existing, structure] = await Promise.all([
      loadDataSlots(editId),
      buildDataSlotStructure(id, editId),
    ]);
    if (!structure) {
      // No questions → nothing to assign.
      return successResponse({ slots: existing, assigned: 0, created: 0 }, forkMeta(fork));
    }

    // Orphans = version questions not covered by any slot, optionally narrowed to the requested keys.
    const slotted = new Set(existing.flatMap((s) => s.questionKeys));
    const requested = requestedKeys ? new Set(requestedKeys) : null;
    const orphanQuestions = structure.questions.filter(
      (q) => !slotted.has(q.key) && (!requested || requested.has(q.key))
    );
    if (orphanQuestions.length === 0) {
      return successResponse({ slots: existing, assigned: 0, created: 0 }, forkMeta(fork));
    }
    const orphanKeys = orphanQuestions.map((q) => q.key);

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Data-slot generator agent not found; run db:seed', {
        slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
      });
      throw new NotFoundError('Data-slot assignment is not configured');
    }

    // One-shot, idempotent flush of the built-in + app capability handlers (this may be the first
    // capability touch on a fresh server process).
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      ASSIGN_DATA_SLOTS_CAPABILITY_SLUG,
      {
        structure,
        existingSlots: existing.map((s) => ({
          key: s.key,
          name: s.name,
          theme: s.theme,
          description: s.description,
          questionKeys: s.questionKeys,
        })),
        orphanQuestionKeys: orphanKeys,
        versionId: editId,
      },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          dataSlotsAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    if (!dispatch.success || !dispatch.data) {
      log.warn('Data-slot assign failed (fail-soft)', {
        questionnaireId: id,
        versionId: editId,
        orphanCount: orphanKeys.length,
        code: dispatch.error?.code,
        message: dispatch.error?.message,
      });
      return successResponse(
        {
          slots: existing,
          assigned: 0,
          created: 0,
          diagnostic: dispatch.error?.code ?? 'assign_failed',
          diagnosticMessage: dispatch.error?.message,
        },
        forkMeta(fork)
      );
    }

    const { placements } = dispatch.data as AssignDataSlotsData;

    // Deterministic merge: existing slots preserved (only gain keys), new slots appended, every
    // orphan guaranteed a home (fallback slot if the model missed one).
    const existingForMerge: AssignableSlot[] = existing.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      theme: s.theme,
      questionKeys: s.questionKeys,
    }));
    const merged = mergeAssignments(
      existingForMerge,
      placements,
      orphanQuestions.map((q) => ({ key: q.key, prompt: q.prompt, sectionTitle: q.sectionTitle }))
    );

    const slots = await replaceDataSlots(editId, merged);
    const created = Math.max(0, slots.length - existing.length);

    logAdminAction({
      userId: adminId,
      action: 'questionnaire_data_slots.assign',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        assigned: orphanKeys.length,
        created,
        slotCount: slots.length,
      },
      clientIp,
    });
    log.info('Data slots assigned', {
      versionId: editId,
      assigned: orphanKeys.length,
      created,
      slotCount: slots.length,
    });

    return successResponse({ slots, assigned: orphanKeys.length, created }, forkMeta(fork));
  }
);

export const POST = handleAssign;
