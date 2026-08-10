/**
 * Questionnaire Pack download.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/pack?format=pdf|csv|md
 *     &meta=&questions=&dataSlots=&definitions=&setup=
 *   Admin-only. Downloads a branded, shareable "pack" covering how the questionnaire is set up —
 *   title/version/goals, the question structure, the data slots (with linked questions), the
 *   definitions/glossary, and a curated experience-setup summary — as a PDF, CSV, or Markdown file.
 *   Each of the five sections can be toggled off via its query flag (all default `true`). Distinct
 *   from the brand-free `…/instrument` export (F14.9), which is the design-time reviewer copy of
 *   just the questions — this is the external/showcase artifact.
 *
 * Node runtime — `@react-pdf/renderer` needs Node. Bulk read: the same `exportLimiter` sub-cap the
 * instrument/definition routes use. Version-scoped.
 */

import { z } from 'zod';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { buildPackModel } from '@/lib/app/questionnaire/export/build-pack-model';
import { buildPackCsv } from '@/lib/app/questionnaire/export/build-pack-csv';
import { buildPackMarkdown } from '@/lib/app/questionnaire/export/build-pack-markdown';
import { buildGlossaryAppendix } from '@/lib/app/questionnaire/glossary/report-appendix';
import { loadAcceptedGlossaryEntries } from '@/lib/app/questionnaire/glossary/resolve';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { loadDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { renderPackPdf } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf';

// React-PDF requires the Node runtime (not edge).
export const runtime = 'nodejs';

/** A `true`/`false` query flag, defaulting to `defaultValue`. */
const includeParam = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

const querySchema = z.object({
  format: z.enum(['pdf', 'csv', 'md']).default('pdf'),
  meta: includeParam('true'),
  questions: includeParam('true'),
  dataSlots: includeParam('true'),
  definitions: includeParam('true'),
  setup: includeParam('true'),
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
    const { format, meta, questions, dataSlots, definitions, setup } = validateQueryParams(
      searchParams,
      querySchema
    );
    const include = { meta, questions, dataSlots, definitions, setup };

    const [questionnaire, graph, dataSlotViews] = await Promise.all([
      prisma.appQuestionnaire.findUnique({ where: { id }, select: { title: true } }),
      getVersionGraph(id, vid),
      loadDataSlots(vid),
    ]);
    if (!questionnaire || !graph) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Definitions / glossary (P16): accepted-only, same as the instrument's reviewer copy — this is
    // a distribution artifact, not the curated proposals/rejections `loadGlossaryForExport` returns.
    const glossary = definitions
      ? buildGlossaryAppendix(await loadAcceptedGlossaryEntries(vid))
      : null;

    const model = buildPackModel(
      questionnaire.title,
      graph,
      dataSlotViews,
      glossary,
      include,
      new Date().toISOString()
    );
    const stem = `pack-${slugify(questionnaire.title)}-v${graph.versionNumber}`;

    log.info('Questionnaire pack download', {
      questionnaireId: id,
      versionId: vid,
      format,
      include,
    });

    if (format === 'md') {
      return new Response(buildPackMarkdown(model), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${stem}.md"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    if (format === 'csv') {
      return new Response(buildPackCsv(model), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${stem}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // PDF — render the React-PDF document to a buffer.
    const buffer = await renderPackPdf(model);
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

export const GET = handleGet;
