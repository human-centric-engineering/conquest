/**
 * Blank-instrument download (F14.9).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/instrument?format=pdf|text|csv
 *   Admin-only. Downloads the questionnaire's *blank instrument* — its numbered sections and
 *   questions (type, required marker, answer options/scale, guidelines) with no respondent data —
 *   as a branded PDF, plain text, or a one-row-per-question CSV. For human review or paper
 *   distribution. Distinct from the results export (`…/export`), which is respondent answers.
 *
 * Node runtime — `@react-pdf/renderer` needs Node. Bulk read: a dedicated `exportLimiter` sub-cap on
 * top of the section tier. Master-flag-gated and version-scoped.
 */

import { z } from 'zod';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { buildInstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';
import { buildInstrumentText } from '@/lib/app/questionnaire/export/build-instrument-text';
import { buildInstrumentCsv } from '@/lib/app/questionnaire/export/build-instrument-csv';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { renderInstrumentPdf } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/instrument/render-instrument-pdf';

// React-PDF requires the Node runtime (not edge).
export const runtime = 'nodejs';

const querySchema = z.object({
  format: z.enum(['pdf', 'text', 'csv']).default('pdf'),
});

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
    const rl = exportLimiter.check(`export:user:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const { searchParams } = new URL(request.url);
    const { format } = validateQueryParams(searchParams, querySchema);

    const [questionnaire, graph] = await Promise.all([
      prisma.appQuestionnaire.findUnique({ where: { id }, select: { title: true } }),
      getVersionGraph(id, vid),
    ]);
    if (!questionnaire || !graph) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const model = buildInstrumentModel(questionnaire.title, graph, new Date().toISOString());
    const stem = `instrument-${slugify(questionnaire.title)}-v${graph.versionNumber}`;

    log.info('Questionnaire instrument download', { questionnaireId: id, versionId: vid, format });

    if (format === 'text') {
      return new Response(buildInstrumentText(model), {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${stem}.txt"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    if (format === 'csv') {
      return new Response(buildInstrumentCsv(model), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${stem}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // PDF — render the React-PDF document to a buffer.
    const buffer = await renderInstrumentPdf(model);
    // Buffer → a fresh Uint8Array so the BodyInit is a plain ArrayBuffer view.
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${stem}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  }
);

export const GET = withQuestionnairesEnabled(handleGet);
