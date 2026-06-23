/**
 * Transcript download response helpers (F7.6).
 *
 * Shared by the transcript PDF + text routes: wrap a rendered artefact in a `Response` with
 * the right content type and an `attachment` disposition, deriving a safe download filename
 * from the questionnaire title + version. `no-store` — an export reflects the session at
 * request time and must never be cached. Sibling to the F7.4 `pdf-response.ts`.
 */

import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

/** Slugify a title for a filename: lower-case, alphanumerics → single hyphens. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'questionnaire';
}

/** `transcript-<slug>-v<N>.<ext>` — the shared download filename. */
function transcriptFilename(model: TranscriptExportModel, ext: 'pdf' | 'txt'): string {
  return `transcript-${slugify(model.questionnaireTitle)}-v${model.versionNumber}.${ext}`;
}

/** Build the download response for a rendered transcript PDF. */
export function transcriptPdfResponse(buffer: Buffer, model: TranscriptExportModel): Response {
  const filename = transcriptFilename(model, 'pdf');
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

/** Build the download response for a rendered transcript text document. */
export function transcriptTextResponse(text: string, model: TranscriptExportModel): Response {
  const filename = transcriptFilename(model, 'txt');
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
