/**
 * Cohort Report rich-text bridge (report kind `cohort`, F14.5).
 *
 * Section bodies are stored as HTML so the Tiptap editor (F14.5) and the read view / PDF (F14.6) all
 * speak one format. The AI generates markdown (F14.3), so `markdownToHtml` converts it once at the
 * generation boundary. Output is NOT sanitised here — it is sanitised at the render boundary
 * (dompurify on the client), the standard defence against any raw HTML smuggled through the model's
 * markdown. Pure (marked is synchronous).
 */

import { marked } from 'marked';

/** Convert a markdown string to an HTML string (GFM). Synchronous; sanitised at render. */
export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return '';
  // `async: false` keeps the return type a string (marked can return a Promise when async).
  return marked.parse(markdown, { async: false, gfm: true });
}
