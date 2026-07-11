/**
 * Cohort Report — content contract + prompt substrate (report kind `cohort`, F14.3).
 *
 * `CohortReportContent` is the version-controlled body stored in an `AppCohortReportRevision`: an
 * opening summary, ordered narrative sections (each optionally referencing charts), the proposed
 * chart catalog, plus recommendations and actions. {@link validateCohortReportContent} bounds and
 * sanitises the agent's output (dropping malformed charts + dangling chart references) so a bad
 * generation can never persist a broken revision. {@link buildCohortDatasetDigest} and
 * {@link buildChartCatalogText} render the {@link CohortDataset} into the compact, k-anonymity-safe
 * text the agent reasons over. All pure — no I/O.
 */

import {
  COHORT_CHART_KINDS,
  COHORT_CHART_DISPLAYS,
  type ChartSpec,
} from '@/lib/app/questionnaire/cohort-report/chart-types';
import { SUBGROUP_DIMENSION_KEY } from '@/lib/app/questionnaire/cohort-report/types';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';
import type { QuestionDistribution } from '@/lib/app/questionnaire/analytics/views';
import { isRecord } from '@/lib/utils';

/** How a section's body string is encoded: AI-generated markdown, or editor-produced HTML. */
export type CohortReportSectionFormat = 'markdown' | 'html';

/** One woven narrative section: a heading, an analysed body, and optional referenced chart ids. */
export interface CohortReportSection {
  heading: string;
  /** The section body — markdown when AI-generated (F14.3), HTML once edited in the Tiptap editor (F14.5). */
  body: string;
  /** How {@link body} is encoded; defaults to `markdown`. The read view + PDF render accordingly. */
  format?: CohortReportSectionFormat;
  /** Ids of charts (from {@link CohortReportContent.charts}) to render within this section. */
  chartIds: string[];
}

/** The full version-controlled body of a cohort report. */
export interface CohortReportContent {
  /** Opening framing / executive summary. */
  summary: string;
  sections: CohortReportSection[];
  /** The chart catalog the sections reference by `ChartSpec.id`. */
  charts: ChartSpec[];
  recommendations: string[];
  actions: string[];
}

/* ── Bounds (Zod-free; the agent output is sanitised, not rejected) ─────────── */
const MAX_SUMMARY = 6000;
const MAX_SECTIONS = 24;
const MAX_HEADING = 200;
const MAX_BODY = 8000;
const MAX_CHARTS = 24;
const MAX_TITLE = 200;
const MAX_LIST = 20;
const MAX_LIST_ITEM = 1000;

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => asText(v, MAX_LIST_ITEM))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST);
}

/** Validate + sanitise one proposed chart spec; null if unusable. */
function validateChartSpec(value: unknown): ChartSpec | null {
  if (!isRecord(value)) return null;
  const id = asText(value.id, 64);
  const title = asText(value.title, MAX_TITLE);
  const kind = value.kind;
  if (!id || !title) return null;
  if (typeof kind !== 'string' || !(COHORT_CHART_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const display =
    typeof value.display === 'string' &&
    (COHORT_CHART_DISPLAYS as readonly string[]).includes(value.display)
      ? (value.display as ChartSpec['display'])
      : undefined;
  return {
    id,
    title,
    kind: kind as ChartSpec['kind'],
    questionId: typeof value.questionId === 'string' ? value.questionId : undefined,
    dataSlotKey: typeof value.dataSlotKey === 'string' ? value.dataSlotKey : undefined,
    dimensionKey: typeof value.dimensionKey === 'string' ? value.dimensionKey : undefined,
    display,
  };
}

/**
 * Validate + sanitise an agent's cohort-report content. Always returns a usable object (never null):
 * fields are coerced + bounded, malformed charts are dropped, duplicate chart ids are de-duped, and
 * section `chartIds` that don't resolve to a surviving chart are pruned. A wholly malformed input
 * yields an empty-but-valid shell (the caller treats an empty summary + no sections as a failure).
 */
export function validateCohortReportContent(raw: unknown): CohortReportContent {
  const obj = isRecord(raw) ? raw : {};

  const seenChartIds = new Set<string>();
  const charts: ChartSpec[] = [];
  if (Array.isArray(obj.charts)) {
    for (const c of obj.charts) {
      const spec = validateChartSpec(c);
      if (!spec || seenChartIds.has(spec.id)) continue;
      seenChartIds.add(spec.id);
      charts.push(spec);
      if (charts.length >= MAX_CHARTS) break;
    }
  }

  const sections: CohortReportSection[] = [];
  if (Array.isArray(obj.sections)) {
    for (const s of obj.sections) {
      if (!isRecord(s)) continue;
      const heading = asText(s.heading, MAX_HEADING);
      const body = asText(s.body, MAX_BODY);
      if (!heading && !body) continue;
      const chartIds = Array.isArray(s.chartIds)
        ? s.chartIds
            .filter((id): id is string => typeof id === 'string' && seenChartIds.has(id))
            .slice(0, MAX_CHARTS)
        : [];
      const format: CohortReportSectionFormat = s.format === 'html' ? 'html' : 'markdown';
      sections.push({ heading, body, format, chartIds });
      if (sections.length >= MAX_SECTIONS) break;
    }
  }

  return {
    summary: asText(obj.summary, MAX_SUMMARY),
    sections,
    charts,
    recommendations: asStringList(obj.recommendations),
    actions: asStringList(obj.actions),
  };
}

/** True when content has at least a summary or one section — the minimum for a usable report. */
export function isUsableCohortReportContent(content: CohortReportContent): boolean {
  return content.summary.trim().length > 0 || content.sections.length > 0;
}

/* ── Dataset → prompt text ──────────────────────────────────────────────────── */

/** A one-line, k-anonymity-safe summary of a question's distribution. */
function summariseQuestion(q: QuestionDistribution): string {
  const head = `- "${q.prompt}" (${q.type}, ${Math.round(q.responseRate * 100)}% responded)`;
  const d = q.detail;
  switch (d.kind) {
    case 'suppressed':
      return `${head}: [hidden — too few respondents]`;
    case 'choice': {
      const top = [...d.buckets].sort((a, b) => b.count - a.count).slice(0, 4);
      return `${head}: ${top.map((b) => `${b.label}=${b.count}`).join(', ')}`;
    }
    case 'likert': {
      const mean = d.mean === null ? 'n/a' : d.mean.toFixed(2);
      return `${head}: mean ${mean} (${d.min}–${d.max})`;
    }
    case 'matrix': {
      const parts = d.rows.map((r) => `${r.label}=${r.mean === null ? 'n/a' : r.mean.toFixed(2)}`);
      return `${head}: mean by row (${d.min}–${d.max}) ${parts.join(', ')}`;
    }
    case 'numeric':
      return `${head}: ${d.summary ? `mean ${d.summary.mean.toFixed(1)}, range ${d.summary.min}–${d.summary.max}` : 'no numeric answers'}`;
    case 'boolean':
      return `${head}: ${d.trueLabel}=${d.trueCount}, ${d.falseLabel}=${d.falseCount}`;
    case 'date':
      return `${head}: ${d.buckets.map((b) => `${b.label}=${b.count}`).join(', ')}`;
    case 'free_text':
      return `${head}: [free text — not aggregated]`;
  }
}

/**
 * Render a {@link CohortDataset} into the compact textual digest the agent reasons over: overall
 * per-question summaries plus per-dimension segment comparisons. k-anonymity-suppressed questions and
 * segments are surfaced as "[hidden]" — never their values — so the agent can't leak them. Capped to
 * keep the prompt bounded.
 */
export function buildCohortDatasetDigest(dataset: CohortDataset): string {
  const lines: string[] = [];
  lines.push(
    `${dataset.roundName}: ${dataset.totalSessions} respondents (${dataset.completedSessions} completed).` +
      (dataset.anonymous ? ' Anonymous mode — no demographic breakdowns available.' : '')
  );
  if (dataset.suppressed) {
    lines.push('NOTE: the whole cohort is below the privacy threshold; detail is withheld.');
  }

  lines.push('', 'OVERALL RESULTS:');
  for (const q of dataset.overall) lines.push(summariseQuestion(q));

  for (const dim of dataset.segmentation) {
    lines.push('', `BY ${dim.dimension.label.toUpperCase()}:`);
    for (const seg of dim.segments) {
      const completion =
        seg.totalSessions > 0 ? Math.round((seg.completedSessions / seg.totalSessions) * 100) : 0;
      lines.push(
        `  ${seg.label} — ${seg.totalSessions} respondents, ${completion}% completed${seg.suppressed ? ' [detail hidden — too few]' : ''}`
      );
      if (!seg.suppressed) {
        for (const q of seg.questions) {
          if (q.detail.kind === 'likert' && q.detail.mean !== null) {
            lines.push(`    "${q.prompt}": mean ${q.detail.mean.toFixed(2)}`);
          }
        }
      }
    }
  }

  if (dataset.dataSlots && dataset.dataSlots.overall.length > 0) {
    lines.push(
      '',
      'DATA SLOTS (the semantic positions captured — the substance of the responses):'
    );
    for (const slot of dataset.dataSlots.overall) {
      if (slot.suppressed) {
        lines.push(`  ${slot.name} [${slot.theme}]: [hidden — too few respondents]`);
        continue;
      }
      const conf = slot.avgConfidence === null ? 'n/a' : slot.avgConfidence.toFixed(2);
      lines.push(
        `  ${slot.name} [${slot.theme}]: ${slot.filled} filled (${Math.round(slot.responseRate * 100)}%), avg confidence ${conf}`
      );
    }
    for (const dim of dataset.dataSlots.byDimension) {
      for (const slot of dim.slots) {
        const parts = slot.segments
          .filter((s) => !s.suppressed && s.totalSessions > 0)
          .map((s) => `${s.label} ${Math.round((s.filled / s.totalSessions) * 100)}%`);
        if (parts.length > 0) {
          lines.push(`  ${slot.name} fill by ${dim.dimensionLabel}: ${parts.join(', ')}`);
        }
      }
    }
  }

  if (dataset.scoring && dataset.scoring.scales.length > 0) {
    lines.push('', 'SCORING (deterministic scales):');
    for (const scale of dataset.scoring.scales) {
      if (scale.suppressed || scale.mean === null) {
        lines.push(`  ${scale.scaleName}: [hidden — too few respondents]`);
        continue;
      }
      const bands = scale.bandCounts.map((b) => `${b.label}=${b.count}`).join(', ');
      lines.push(
        `  ${scale.scaleName}: mean ${scale.mean.toFixed(2)} (n=${scale.respondents})${bands ? ` — ${bands}` : ''}`
      );
    }
    for (const dim of dataset.scoring.byDimension) {
      for (const scale of dim.scales) {
        const parts = scale.segments
          .filter((s) => !s.suppressed && s.mean !== null)
          .map((s) => `${s.label}=${s.mean!.toFixed(2)}`);
        if (parts.length > 0) {
          lines.push(`  ${scale.scaleName} by ${dim.dimensionLabel}: ${parts.join(', ')}`);
        }
      }
    }
  }

  // Bound the digest so a huge questionnaire can't blow the prompt.
  return lines.join('\n').slice(0, 16_000);
}

/**
 * The machine-readable catalog of what the agent may chart — the exact `questionId`s and
 * `dimensionKey`s available — so every `ChartSpec` it proposes resolves against the dataset.
 */
export function buildChartCatalogText(dataset: CohortDataset): string {
  const lines: string[] = ['QUESTIONS (use as questionId):'];
  for (const q of dataset.overall) {
    lines.push(`  ${q.questionId} — "${q.prompt}" (${q.type})`);
  }
  if (dataset.dataSlots && dataset.dataSlots.overall.length > 0) {
    lines.push('DATA SLOTS (use as dataSlotKey):');
    for (const slot of dataset.dataSlots.overall) {
      lines.push(`  ${slot.key} — ${slot.name} [${slot.theme}]`);
    }
  }
  if (dataset.segmentation.length > 0) {
    lines.push('DIMENSIONS (use as dimensionKey):');
    for (const dim of dataset.segmentation) {
      const which = dim.dimension.key === SUBGROUP_DIMENSION_KEY ? '(subgroup)' : '(profile)';
      lines.push(`  ${dim.dimension.key} — ${dim.dimension.label} ${which}`);
    }
  }
  return lines.join('\n').slice(0, 8_000);
}
