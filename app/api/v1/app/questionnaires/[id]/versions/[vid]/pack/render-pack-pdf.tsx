/**
 * Questionnaire Pack render helper.
 *
 * Renders the {@link PackPdfDocument} to a Node Buffer via `@react-pdf/renderer`. Kept as a `.tsx`
 * route-local seam (the document is JSX) so the route stays plain `.ts`. Sibling to
 * {@link file://../instrument/render-instrument-pdf.tsx}.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import { PackPdfDocument } from '@/components/app/questionnaire/export/pack-pdf-document';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';

export async function renderPackPdf(model: PackModel): Promise<Buffer> {
  return renderToBuffer(<PackPdfDocument model={model} />);
}
