/**
 * Blank-instrument export — CSV serialiser (F14.9).
 *
 * Renders an {@link InstrumentModel} as one row per question (a flat, spreadsheet-friendly view of
 * the questionnaire's structure — no respondent answers). Every cell goes through {@link csvEscape}
 * for RFC 4180 quoting + formula-injection neutralisation. Sibling to the results CSV
 * ({@link file://./results-serialize.ts}); pure string building, no external library.
 */

import { csvEscape } from '@/lib/api/csv';
import type { InstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';

/** Column headers — one row per question. */
const HEADERS = [
  'section_number',
  'section_title',
  'question_number',
  'key',
  'prompt',
  'type',
  'required',
  'weight',
  'options',
  'constraint',
  'guidelines',
  'tags',
] as const;

/** Serialise the instrument model to a CSV document. */
export function buildInstrumentCsv(model: InstrumentModel): string {
  const rows: string[] = [HEADERS.join(',')];

  for (const section of model.sections) {
    for (const q of section.questions) {
      const cells = [
        String(section.number),
        section.title,
        q.number,
        q.key,
        q.prompt,
        q.typeLabel,
        q.required ? 'yes' : 'no',
        String(q.weight),
        q.options.join(' | '),
        q.constraint ?? '',
        q.guidelines ?? '',
        q.tags.join(', '),
      ];
      rows.push(cells.map(csvEscape).join(','));
    }
  }

  return `${rows.join('\r\n')}\r\n`;
}
