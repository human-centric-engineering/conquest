/**
 * pdfjs-dist ships no types for its worker entry point.
 *
 * `lib/orchestration/knowledge/parsers/pdf-parser.ts` imports this module with a
 * literal specifier and assigns it to `globalThis.pdfjsWorker`, which is how
 * pdfjs finds a main-thread worker instead of resolving one at runtime (see the
 * comment on `registerPdfWorker`). Only the one export it looks for is declared —
 * we never call it ourselves, so the handler stays `unknown`.
 */
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
