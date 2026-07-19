/**
 * Generate data-slot embeddings for adaptive data-slot selection.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/embed-data-slots
 *   Admin-only. Returns the version's data-slot embedding coverage
 *   `{ total, embedded, missing }` — backs the Settings-tab "Generate embeddings" (data-slots
 *   variant) status and the adaptive launch-gate check. Cheap (a single COUNT).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/embed-data-slots
 *   body: { force?: boolean }   // re-embed every data slot, not just un-embedded ones
 *
 *   Admin-only. Embeds the version's data slots into the pgvector `embedding` column so adaptive
 *   data-slot selection can rank candidates by similarity. Idempotent by default (skips slots that
 *   already have an embedding); `force: true` re-embeds all (e.g. after editing name/description).
 *
 *   Expensive — one batch of embedding-API calls — so it takes the same tight per-admin sub-cap as
 *   the question-slot embedder (`embedSlotsLimiter`) on top of the section 100/min. 404 when the
 *   version doesn't resolve under the questionnaire.
 *
 *   Independent of adaptive data-slot selection: an admin may pre-generate embeddings before
 *   turning the feature on. See `_lib/data-slot-embeddings.ts`.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  dataSlotEmbeddingCoverage,
  embedVersionDataSlots,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { embedSlotsLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({ force: z.boolean().optional() }).default({});

const handleCoverage = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }
    return successResponse(await dataSlotEmbeddingCoverage(vid));
  }
);

const handleEmbedDataSlots = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // Validate before consuming the limiter token, so a malformed body 400s without burning the
    // admin's embedding budget.
    const body = await validateRequestBody(request, bodySchema);

    // Per-admin sub-cap — embedding every slot is a batch of API calls (shared with question slots).
    const rl = embedSlotsLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Data-slot embedding rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const result = await embedVersionDataSlots(vid, { onlyMissing: !body.force });

    log.info('Questionnaire data-slot embeddings generated', {
      questionnaireId: id,
      versionId: vid,
      ...result,
      force: body.force ?? false,
    });

    return successResponse(result);
  }
);

export const GET = handleCoverage;
export const POST = handleEmbedDataSlots;
