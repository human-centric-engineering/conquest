/**
 * Cohort Report PDF model (report kind `cohort`, F14.6) — pure.
 *
 * Projects a {@link CohortReportContent} + {@link CohortDataset} + resolved theme into the flat,
 * serializable model the react-pdf document renders. Section bodies (HTML) are flattened to text
 * paragraphs (react-pdf renders text, not rich HTML); charts are resolved to the shared
 * {@link ChartData} and rendered as simple labelled bars in the PDF. No I/O — unit-tested directly.
 */

import { buildChartData } from '@/lib/app/questionnaire/cohort-report/chart-series';
import type { ChartData } from '@/lib/app/questionnaire/cohort-report/chart-types';
import type { CohortReportContent } from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

/** One rendered chart in the PDF: title + labelled values (percent-aware), or a suppressed note. */
export interface PdfChart {
  title: string;
  isPercent: boolean;
  suppressed: boolean;
  empty: boolean;
  bars: { label: string; value: number }[];
}

export interface PdfSection {
  heading: string;
  /** Body flattened to plain-text paragraphs. */
  paragraphs: string[];
  charts: PdfChart[];
}

export interface CohortReportPdfModel {
  title: string;
  accentColor: string;
  logoDataUri: string | null;
  roundName: string;
  totalRespondents: number;
  summaryParagraphs: string[];
  sections: PdfSection[];
  recommendations: string[];
  actions: string[];
}

/** Strip all HTML tags, looping to a fixpoint so a stripped match can't reconstruct a new tag. */
function stripTags(input: string): string {
  let prev: string;
  let out = input;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  return out;
}

/** Flatten an HTML (or markdown) body to plain-text paragraphs. Block tags → paragraph breaks. */
export function htmlToParagraphs(body: string): string[] {
  const withBreaks = body
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  // Decode `&amp;` LAST so an already-escaped entity like `&amp;lt;` decodes to the literal
  // text `&lt;` rather than being double-unescaped into `<`.
  const stripped = stripTags(withBreaks)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return stripped
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Project a {@link ChartData} into the PDF's simple bar shape. */
function toPdfChart(data: ChartData): PdfChart {
  return {
    title: data.spec.title,
    isPercent: data.isPercent,
    suppressed: data.suppressed,
    empty: data.empty,
    bars: data.data.map((d) => ({ label: d.category, value: d.values.count ?? 0 })),
  };
}

/** Build the flat PDF model. `logoDataUri` is pre-fetched by the route (network stays out of render). */
export function buildCohortReportPdfModel(params: {
  content: CohortReportContent;
  dataset: CohortDataset;
  title: string;
  accentColor: string;
  logoDataUri: string | null;
}): CohortReportPdfModel {
  const { content, dataset, title, accentColor, logoDataUri } = params;
  const chartById = new Map(content.charts.map((c) => [c.id, c]));

  const sections: PdfSection[] = content.sections.map((s) => ({
    heading: s.heading,
    paragraphs: htmlToParagraphs(s.body),
    charts: s.chartIds
      .map((id) => chartById.get(id))
      .filter((spec): spec is NonNullable<typeof spec> => !!spec)
      .map((spec) => toPdfChart(buildChartData(spec, dataset))),
  }));

  return {
    title,
    accentColor,
    logoDataUri,
    roundName: dataset.roundName,
    totalRespondents: dataset.totalSessions,
    summaryParagraphs: htmlToParagraphs(content.summary),
    sections,
    recommendations: content.recommendations,
    actions: content.actions,
  };
}
