/**
 * Generate question-slot embeddings for adaptive selection (F4.1).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/embed-questions
 *   body: { force?: boolean }   // re-embed every slot, not just un-embedded ones
 *
 *   Admin-only. Embeds the version's question slots into the pgvector
 *   `embedding` column so the `adaptive` strategy can rank candidates by
 *   similarity. Idempotent by default (skips slots that already have an
 *   embedding); `force: true` re-embeds all (e.g. after editing prompts).
 *
 *   Expensive — one batch of embedding-API calls — so it takes a tight per-admin
 *   sub-cap on top of the section 100/min. 404 when the master flag is off or the
 *   version doesn't resolve under the questionnaire.
 *
 *   Gated on the master app flag only (not the adaptive sub-flag): an admin may
 *   pre-generate embeddings before turning adaptive on. See
 *   `_lib/slot-embeddings.ts` for the pgvector seam.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { embedVersionSlots } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { embedSlotsLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({ force: z.boolean().optional() }).default({});

const handleEmbedQuestions = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // Validate before consuming the limiter token, so a malformed body 400s
    // without burning the admin's embedding budget.
    const body = await validateRequestBody(request, bodySchema);

    // Per-admin sub-cap — embedding every slot is a batch of API calls.
    const rl = embedSlotsLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Slot-embedding rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const result = await embedVersionSlots(vid, { onlyMissing: !body.force });

    log.info('Questionnaire slot embeddings generated', {
      questionnaireId: id,
      versionId: vid,
      ...result,
      force: body.force ?? false,
    });

    return successResponse(result);
  }
);

export const POST = withQuestionnairesEnabled(handleEmbedQuestions);
