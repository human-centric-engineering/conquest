/**
 * Record-level result export — CSV / JSON serialisers (F8.2).
 *
 * Pure: a {@link ResultsExportModel} in, a string (CSV) or plain object (JSON) out — no
 * Prisma, no Next, no clock. The loader has already applied the anonymous-mode contract
 * (null respondent, empty turns), so these just shape the output.
 *
 * - CSV is **one row per session × question** — the lossy, spreadsheet-friendly view.
 *   Every question appears for every session; an unanswered slot is an empty value cell.
 * - JSON is the **full session graph** (answers + provenance + turns), the faithful
 *   machine-readable view. Returned as a bare object (no API envelope) so the downloaded
 *   file is the data itself.
 */

import { csvEscape } from '@/lib/api/csv';
import type { ResultsExportModel } from '@/lib/app/questionnaire/export/results-types';

/** The CSV header, in column order. Exported so tests assert against one source of truth. */
export const RESULTS_CSV_COLUMNS = [
  'session_id',
  'session_status',
  'created_at',
  'completed_at',
  'respondent_name',
  'section_title',
  'question_key',
  'question_prompt',
  'question_type',
  'answer_value',
  'confidence',
  'provenance_label',
] as const;

/**
 * Stringify a stored answer value for a CSV cell. Faithful over pretty: arrays join with
 * `, ` (multi-choice), objects fall back to JSON, null/empty become an empty cell (so an
 * unanswered slot and an empty answer read the same — blank). Booleans stay `true`/`false`
 * rather than display labels, since CSV is the data view.
 */
export function renderAnswerValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => renderAnswerValue(v)).join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Serialise the model to CSV — one row per session × question. */
export function toResultsCsv(model: ResultsExportModel): string {
  const lines: string[] = [RESULTS_CSV_COLUMNS.join(',')];

  for (const session of model.sessions) {
    const answerByKey = new Map(session.answers.map((a) => [a.questionKey, a]));
    for (const question of model.questions) {
      const answer = answerByKey.get(question.key);
      lines.push(
        [
          csvEscape(session.id),
          csvEscape(session.status),
          csvEscape(session.createdAt),
          csvEscape(session.completedAt ?? ''),
          csvEscape(session.respondentName ?? ''),
          csvEscape(question.sectionTitle),
          csvEscape(question.key),
          csvEscape(question.prompt),
          csvEscape(question.type),
          csvEscape(answer ? renderAnswerValue(answer.value) : ''),
          csvEscape(answer?.confidence != null ? String(answer.confidence) : ''),
          csvEscape(answer?.provenanceLabel ?? ''),
        ].join(',')
      );
    }
  }

  return lines.join('\n');
}

/**
 * Serialise the model to the JSON export object — the full session graph. Returned bare
 * (not wrapped in the API success envelope) so the downloaded file is the data itself.
 */
export function toResultsJson(model: ResultsExportModel): ResultsExportModel {
  return model;
}
