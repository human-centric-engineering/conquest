/**
 * Cohort Report PDF render helper (report kind `cohort`, F14.6).
 *
 * Builds the flat PDF model (best-effort logo prefetch → data URI, so no network call happens inside
 * react-pdf's render) and renders the {@link CohortReportPdfDocument} to a Node Buffer. Node-only —
 * the route pins `runtime = 'nodejs'`. Mirrors the session-export render helper.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import { CohortReportPdfDocument } from '@/components/app/questionnaire/cohort-report/cohort-report-pdf-document';
import { buildCohortReportPdfModel } from '@/lib/app/questionnaire/cohort-report/pdf-model';
import type { CohortReportContent } from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

const LOGO_FETCH_TIMEOUT_MS = 3_000;
const LOGO_MAX_BYTES = 2_000_000;

/** Best-effort fetch of an https logo into a base64 data URI (so render does no network I/O). */
async function fetchLogoDataUri(url: string | null): Promise<string | null> {
  if (!url || !url.startsWith('https://')) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > LOGO_MAX_BYTES) return null;
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Render a cohort report to a themed PDF byte buffer. */
export async function renderCohortReportPdf(params: {
  content: CohortReportContent;
  dataset: CohortDataset;
  title: string;
  accentColor: string;
  logoUrl: string | null;
}): Promise<Buffer> {
  const logoDataUri = await fetchLogoDataUri(params.logoUrl);
  const model = buildCohortReportPdfModel({
    content: params.content,
    dataset: params.dataset,
    title: params.title,
    accentColor: params.accentColor,
    logoDataUri,
  });
  return renderToBuffer(<CohortReportPdfDocument model={model} />);
}
