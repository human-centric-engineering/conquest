/**
 * Version-wide Report PDF export (report kind `cohort`, version scope).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/cohort-report/export.pdf?revision=head|published|<n>
 *   Admin-only. Renders the chosen revision (default `head`) as a themed PDF, available for any
 *   revision so a draft can be downloaded "during the process". A version-wide report has no
 *   cohort/demo-client, so it renders with the default theme. Gated by the cohort-report flag.
 *
 * `runtime = 'nodejs'`: `@react-pdf/renderer` renders to a Node Buffer.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { z } from 'zod';

import { resolveTheme } from '@/lib/app/questionnaire/theming';
import {
  buildCohortDataset,
  getCohortReportRevisionContent,
} from '@/lib/app/questionnaire/cohort-report';
import { loadVersionReportScope } from '@/app/api/v1/app/questionnaires/_lib/version-report';
import { renderCohortReportPdf } from '@/app/api/v1/app/rounds/[id]/cohort-report/_lib/render-cohort-report-pdf';

export const runtime = 'nodejs';

type Params = { id: string; vid: string };

const querySchema = z.object({
  revision: z.string().max(20).optional(),
});

function resolveWhich(raw: string | undefined): number | 'head' | 'published' {
  if (!raw || raw === 'head') return 'head';
  if (raw === 'published') return 'published';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'head';
}

const handleExportPdf = withAdminAuth<Params>(
  async (request: NextRequest, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id, vid } = await params;

      const resolved = await loadVersionReportScope(id, vid);
      if (!resolved) throw new NotFoundError('Questionnaire version not found');

      const { searchParams } = new URL(request.url);
      const { revision } = validateQueryParams(searchParams, querySchema);

      const scope = resolved.scope;
      const revisionData = await getCohortReportRevisionContent(scope, resolveWhich(revision));
      if (!revisionData) {
        return errorResponse('No version report to export', { code: 'NO_REPORT', status: 404 });
      }

      const dataset = await buildCohortDataset(scope);
      const theme = resolveTheme(null);

      const pdf = await renderCohortReportPdf({
        content: revisionData.content,
        dataset,
        title: revisionData.title,
        accentColor: theme.accentColor,
        logoUrl: theme.logoUrl,
      });

      log.info('Version report PDF generated', {
        questionnaireId: id,
        versionId: vid,
        revisionNumber: revisionData.revisionNumber,
      });

      const filename = `version-report-r${revisionData.revisionNumber}.pdf`;
      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const GET = handleExportPdf;
