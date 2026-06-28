/**
 * Instrument PDF render helper (F14.9).
 *
 * Renders the {@link InstrumentPdfDocument} to a Node Buffer via `@react-pdf/renderer`. Kept as a
 * `.tsx` route-local seam (the document is JSX) so the route stays plain `.ts`. Sibling to
 * {@link file://../../../../questionnaire-sessions/_lib/render-transcript-pdf.tsx}.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import { InstrumentPdfDocument } from '@/components/app/questionnaire/export/instrument-pdf-document';
import type { InstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';

export async function renderInstrumentPdf(model: InstrumentModel): Promise<Buffer> {
  return renderToBuffer(<InstrumentPdfDocument model={model} />);
}
