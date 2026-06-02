/**
 * Questionnaire version-graph endpoint (P2 / F2.1a).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid
 *   Admin-only read of one version's full structural graph — sections (ordered)
 *   each with their ordered questions — plus goal/audience and their stored
 *   per-field provenance (`goalProvenance`/`audienceProvenance`). The version is
 *   scoped to its parent questionnaire, so a mismatched id/vid pair 404s rather
 *   than leaking a version from another questionnaire. 404 when the feature flag
 *   is off. Read model: `_lib/detail.ts`.
 *
 * Version-scoped path (`…/versions/:vid/…`) is the convention later F2 work
 * reuses (F2.4 re-ingest, F5 evaluate).
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';

const handleVersionGraph = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const graph = await getVersionGraph(id, vid);
    if (!graph) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    log.info('Questionnaire version graph read', {
      questionnaireId: id,
      versionId: vid,
      sectionCount: graph.sections.length,
    });
    return successResponse(graph);
  }
);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; vid: string }> }
): Promise<Response> {
  // Flag gate first — a switched-off app is indistinguishable from a missing route.
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleVersionGraph(request, context);
}
