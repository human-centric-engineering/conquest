/**
 * Questionnaire Pack export — CSV serialiser.
 *
 * Unlike the instrument's one-row-per-question CSV (`build-instrument-csv.ts`), the pack is
 * multi-section — meta, data slots, questions, and definitions don't share one table shape. Each
 * included section renders as a self-describing block: a `# Heading` comment row, that block's own
 * header row, then its data rows, with a blank line between blocks. Every cell goes through
 * {@link csvEscape} for RFC 4180 quoting + formula-injection neutralisation. Pure string building, no
 * external library — sibling to `build-instrument-csv.ts` and `build-pack-markdown.ts`.
 */

import { csvEscape } from '@/lib/api/csv';
import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';

/** One CSV row from raw cell values. */
function row(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/** Serialise the pack model to a CSV document — one block per included section. */
export function buildPackCsv(model: PackModel): string {
  const blocks: string[][] = [];

  blocks.push([
    row(['ConQuest', PACK_BRAND.tagline, PACK_BRAND.website]),
    row(['Questionnaire pack', model.title]),
    row(['Generated', model.generatedAt]),
  ]);

  if (model.meta) {
    blocks.push([
      '# Meta',
      row(['field', 'value']),
      row(['Title', model.title]),
      row(['Version', String(model.versionNumber)]),
      row(['Goal', model.meta.goal ?? '']),
      row(['Audience', model.meta.audienceSummary ?? '']),
      row(['Sections', String(model.sectionCount)]),
      row(['Questions', String(model.questionCount)]),
    ]);
  }

  if (model.setup) {
    blocks.push([
      '# Experience setup',
      row(['field', 'value']),
      ...model.setup.map((item) => row([item.label, item.value])),
    ]);
  }

  if (model.dataSlots) {
    blocks.push([
      '# Data slots',
      row(['key', 'name', 'theme', 'description', 'weight', 'questions']),
      ...model.dataSlots.map((slot) =>
        row([
          slot.key,
          slot.name,
          slot.theme,
          slot.description,
          String(slot.weight),
          slot.questions.map((q) => q.prompt).join(' | '),
        ])
      ),
    ]);
  }

  if (model.sections) {
    const questionRows: string[] = [];
    for (const section of model.sections) {
      for (const q of section.questions) {
        questionRows.push(
          row([
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
          ])
        );
      }
    }
    blocks.push([
      '# Questions',
      row([
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
      ]),
      ...questionRows,
    ]);
  }

  if (model.glossary) {
    blocks.push([
      '# Definitions',
      row(['term', 'definition']),
      ...model.glossary.entries.flatMap((entry) =>
        entry.definitions.map((definition) => row([entry.term, definition]))
      ),
    ]);
  }

  return `${blocks.map((block) => block.join('\r\n')).join('\r\n\r\n')}\r\n`;
}
