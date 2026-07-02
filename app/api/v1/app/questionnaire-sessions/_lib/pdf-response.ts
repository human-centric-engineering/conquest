/**
 * PDF download response helper (F7.4).
 *
 * Shared by the respondent + admin export routes: wraps a rendered PDF buffer in a
 * `Response` with the `application/pdf` content type and an `attachment` disposition,
 * and derives a safe download filename from the questionnaire title + version. `no-store`
 * — an export reflects the session at request time and must never be cached.
 */

import { slugify } from '@/lib/utils';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/** Build the download response for a rendered session PDF. */
export function sessionPdfResponse(buffer: Buffer, model: SessionExportModel): Response {
  const filename = `responses-${slugify(model.questionnaireTitle) || 'questionnaire'}-v${model.versionNumber}.pdf`;
  // Buffer → a fresh Uint8Array so the BodyInit is a plain ArrayBuffer view (avoids the
  // SharedArrayBuffer-typed overload Node's Buffer can surface under some TS lib configs).
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
