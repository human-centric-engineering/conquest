'use client';

/**
 * CohortSectionBody — renders a cohort-report section body (report kind `cohort`, F14.5).
 *
 * Section bodies are HTML once generated/edited; legacy revisions may be markdown. HTML is sanitised
 * with dompurify at this render boundary (the standard XSS defence for stored rich text) before it
 * goes through `dangerouslySetInnerHTML`; markdown falls back to the shared markdown renderer.
 */

import * as React from 'react';
import DOMPurify from 'dompurify';

import { MarkdownOrRawView } from '@/components/admin/orchestration/markdown-or-raw-view';
import type { CohortReportSectionFormat } from '@/lib/app/questionnaire/cohort-report/content';

export interface CohortSectionBodyProps {
  body: string;
  format?: CohortReportSectionFormat;
}

/** Tags + attrs the report body is allowed to use (Tiptap StarterKit output + headings). */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'code',
  'pre',
  'a',
];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

export function CohortSectionBody({ body, format }: CohortSectionBodyProps) {
  const safeHtml = React.useMemo(
    () => (format === 'html' ? DOMPurify.sanitize(body, { ALLOWED_TAGS, ALLOWED_ATTR }) : null),
    [body, format]
  );

  if (safeHtml !== null) {
    return (
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        // Sanitised above with an explicit tag/attr allowlist — no scripts/styles/handlers survive.
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
    );
  }
  return <MarkdownOrRawView content={body} />;
}
