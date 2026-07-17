/**
 * Questionnaire **definition** export (F14.9).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/definition
 *   Admin-only. Downloads a version's full design-time definition as a portable JSON envelope:
 *   structure (sections → questions → tags) + run-time config + semantic data slots + scoring schema
 *   — no respondent data, no embedding vectors. The counterpart of the settings-only export on the
 *   Settings tab; importable through `POST …/questionnaires/import` to clone the questionnaire.
 *
 * Bulk read — a dedicated `exportLimiter` sub-cap sits on top of the section tier. Master-flag-gated
 * and version-scoped.
 */

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { buildDefinitionExport } from '@/lib/app/questionnaire/authoring';
import { narrowScoringSchemaContent } from '@/lib/app/questionnaire/scoring';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { loadDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';

/** Slugify a title for a filename: lower-case, alphanumerics → single hyphens. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'questionnaire';
}

const handleGet = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    // Bulk-read sub-cap (10/min/user) on top of the section tier — like the results export.
    const rl = exportLimiter.check(`export:user:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const [questionnaire, graph, dataSlots, schemaRow] = await Promise.all([
      prisma.appQuestionnaire.findUnique({ where: { id }, select: { title: true } }),
      getVersionGraph(id, vid),
      loadDataSlots(vid),
      prisma.appScoringSchema.findUnique({
        where: { versionId: vid },
        select: { name: true, content: true },
      }),
    ]);

    if (!questionnaire || !graph) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const scoring = schemaRow
      ? { name: schemaRow.name, content: narrowScoringSchemaContent(schemaRow.content) }
      : null;

    const envelope = buildDefinitionExport(
      questionnaire.title,
      graph,
      dataSlots,
      scoring,
      new Date().toISOString()
    );

    log.info('Questionnaire definition export', {
      questionnaireId: id,
      versionId: vid,
      sectionCount: graph.sections.length,
      dataSlotCount: dataSlots.length,
      hasScoring: scoring !== null,
    });

    const stem = `definition-${slugify(questionnaire.title)}-v${graph.versionNumber}-${new Date().toISOString().slice(0, 10)}`;

    return new Response(JSON.stringify(envelope, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${stem}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  }
);

export const GET = handleGet;
