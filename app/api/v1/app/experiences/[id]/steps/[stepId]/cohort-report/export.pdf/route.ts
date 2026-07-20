/**
 * Experience-step Report PDF export (report kind `cohort`, experience_step scope — F15.4).
 *
 * GET /api/v1/app/experiences/:id/steps/:stepId/cohort-report/export.pdf?revision=head|published|<n>
 *   Admin-only. Renders the chosen revision (default `head`) as a themed PDF, available for any
 *   revision so a draft can be downloaded "during the process". A step report has no
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
import { loadStepReportScope } from '@/app/api/v1/app/experiences/_lib/step-report';
import { renderCohortReportPdf } from '@/app/api/v1/app/rounds/[id]/cohort-report/_lib/render-cohort-report-pdf';
import {
  resolveRevisionSelector,
  revisionParamSchema,
} from '@/app/api/v1/app/rounds/[id]/cohort-report/_lib/revision-param';

export const runtime = 'nodejs';

type Params = { id: string; stepId: string };

const querySchema = z.object({
  revision: revisionParamSchema,
});

const handleExportPdf = withAdminAuth<Params>(
  async (request: NextRequest, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id, stepId } = await params;

      const resolved = await loadStepReportScope(id, stepId);
      if (!resolved) throw new NotFoundError('Experience step not found');

      const { searchParams } = new URL(request.url);
      const { revision } = validateQueryParams(searchParams, querySchema);

      const scope = resolved.scope;
      const revisionData = await getCohortReportRevisionContent(
        scope,
        resolveRevisionSelector(revision)
      );
      if (!revisionData) {
        return errorResponse('No step report to export', { code: 'NO_REPORT', status: 404 });
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

      log.info('Step report PDF generated', {
        experienceId: id,
        stepId,
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
