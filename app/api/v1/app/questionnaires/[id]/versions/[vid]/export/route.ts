/**
 * Result exports (F8.2).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/export?format=csv|json
 *   Admin-only. Downloads a version's **completed** session results in CSV (one row per
 *   session × question) or JSON (the full session graph: answers + provenance + turns).
 *   Reuses the F8.1 analytics filter (`from`/`to`/`tagIds`), so an export mirrors exactly
 *   what the admin is viewing. Version-scoped.
 *
 *   Anonymous mode (`AppQuestionnaireConfig.anonymousMode`) is honoured in the loader:
 *   respondent identity is nulled and the `turns` array is dropped from the payload.
 *
 * Bulk read — a dedicated `exportLimiter` sub-cap sits on top of the section tier.
 */

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { resolveAnalyticsScope } from '@/lib/app/questionnaire/analytics';
import { resultsExportQuerySchema } from '@/lib/app/questionnaire/export/results-query';
import { loadResultsExport } from '@/lib/app/questionnaire/export/results-loader';
import { toResultsCsv, toResultsJson } from '@/lib/app/questionnaire/export/results-serialize';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

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
    // Bulk-read sub-cap (10/min/user) on top of the section tier — like the
    // orchestration conversation export.
    const rl = exportLimiter.check(`export:user:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const query = validateQueryParams(searchParams, resultsExportQuerySchema);
    const scope = resolveAnalyticsScope(vid, query);

    const model = await loadResultsExport(scope);
    if (!model) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    log.info('Questionnaire results export', {
      versionId: vid,
      format: query.format,
      sessionCount: model.sessions.length,
      capped: model.capped,
    });

    const stem = `results-${slugify(model.questionnaireTitle)}-v${model.versionNumber}-${new Date().toISOString().slice(0, 10)}`;

    if (query.format === 'csv') {
      return new Response(toResultsCsv(model), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${stem}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(JSON.stringify(toResultsJson(model)), {
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
