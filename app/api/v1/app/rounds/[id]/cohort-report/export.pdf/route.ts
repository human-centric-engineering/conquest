/**
 * Cohort Report PDF export (report kind `cohort`, F14.6).
 *
 * GET /api/v1/app/rounds/:id/cohort-report/export.pdf?versionId=…&revision=head|published|<n>
 *   Admin-only. Renders the chosen revision (default `head`) as a themed PDF (demo-client logo +
 *   accent), available for any revision so a draft can be downloaded "during the process". Gated by
 *   the cohort-report flag.
 *
 * `runtime = 'nodejs'`: `@react-pdf/renderer` renders to a Node Buffer.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import {
  buildCohortDataset,
  getCohortReportRevisionContent,
} from '@/lib/app/questionnaire/cohort-report';
import { assertRoundBundlesVersion } from '@/app/api/v1/app/rounds/_lib/context';
import { renderCohortReportPdf } from '@/app/api/v1/app/rounds/[id]/cohort-report/_lib/render-cohort-report-pdf';

export const runtime = 'nodejs';

type Params = { id: string };

const querySchema = z.object({
  versionId: z.string().min(1).max(64),
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
      const { id: roundId } = await params;

      const round = await prisma.appQuestionnaireRound.findUnique({
        where: { id: roundId },
        select: {
          name: true,
          cohort: {
            select: {
              demoClient: {
                select: {
                  accentColor: true,
                  ctaColor: true,
                  ctaColorEnd: true,
                  surfaceColor: true,
                  logoUrl: true,
                  logoBackgroundColor: true,
                  logoBackgroundEnabled: true,
                  welcomeCopy: true,
                },
              },
            },
          },
        },
      });
      if (!round) throw new NotFoundError('Round not found');

      const { searchParams } = new URL(request.url);
      const { versionId, revision } = validateQueryParams(searchParams, querySchema);
      if (!(await assertRoundBundlesVersion(roundId, versionId))) {
        return errorResponse('Version is not bundled by this round', {
          code: 'VERSION_NOT_IN_ROUND',
          status: 422,
        });
      }

      const revisionData = await getCohortReportRevisionContent(roundId, resolveWhich(revision));
      if (!revisionData) {
        return errorResponse('No cohort report to export', { code: 'NO_REPORT', status: 404 });
      }

      const dataset = await buildCohortDataset({ roundId, roundName: round.name, versionId });
      const theme = resolveTheme(round.cohort?.demoClient ?? null);

      const pdf = await renderCohortReportPdf({
        content: revisionData.content,
        dataset,
        title: revisionData.title,
        accentColor: theme.accentColor,
        logoUrl: theme.logoUrl,
      });

      log.info('Cohort report PDF generated', {
        roundId,
        versionId,
        revisionNumber: revisionData.revisionNumber,
      });

      const filename = `cohort-report-r${revisionData.revisionNumber}.pdf`;
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

export const GET = withCohortReportEnabled(handleExportPdf);
