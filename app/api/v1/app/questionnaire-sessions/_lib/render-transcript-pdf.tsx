/**
 * Transcript PDF render helper (F7.6).
 *
 * Renders the {@link TranscriptPdfDocument} to a Node Buffer via `@react-pdf/renderer`.
 * Kept as a `.tsx` route-local seam (the document is JSX) so the route stays plain `.ts`.
 * Sibling to the F7.4 `render-session-pdf.tsx`.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import { TranscriptPdfDocument } from '@/components/app/questionnaire/export/transcript-pdf-document';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

export async function renderTranscriptPdf(model: TranscriptExportModel): Promise<Buffer> {
  return renderToBuffer(<TranscriptPdfDocument model={model} />);
}
