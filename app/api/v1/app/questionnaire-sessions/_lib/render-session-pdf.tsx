/**
 * Session PDF render helper (F7.4).
 *
 * Single source both export routes (respondent + admin) call: takes the assembled
 * {@link SessionExportModel} and renders the {@link SessionPdfDocument} to a PDF buffer
 * via `@react-pdf/renderer`'s `renderToBuffer`. Node-only (the routes pin
 * `runtime = 'nodejs'`), so this stays out of the pure `lib/app/questionnaire/export`
 * module.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import { SessionPdfDocument } from '@/components/app/questionnaire/export/session-pdf-document';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/** Render a session export model to a PDF byte buffer. */
export async function renderSessionPdf(model: SessionExportModel): Promise<Buffer> {
  return renderToBuffer(<SessionPdfDocument model={model} />);
}
