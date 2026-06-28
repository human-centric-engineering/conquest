/**
 * build-instrument-text / build-instrument-csv — unit tests for the blank-instrument serialisers.
 *
 * Pins: the text document's header + numbered questions + options/guidance, and the CSV's header row,
 * one-row-per-question shape, and formula-injection neutralisation (via csvEscape).
 *
 * @see lib/app/questionnaire/export/build-instrument-text.ts
 * @see lib/app/questionnaire/export/build-instrument-csv.ts
 */

import { describe, it, expect } from 'vitest';

import { buildInstrumentText } from '@/lib/app/questionnaire/export/build-instrument-text';
import { buildInstrumentCsv } from '@/lib/app/questionnaire/export/build-instrument-csv';
import type { InstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';

const MODEL: InstrumentModel = {
  title: 'Staff Morale',
  versionNumber: 2,
  goal: 'Understand morale',
  audienceSummary: 'Staff',
  generatedAt: '2026-06-28T00:00:00.000Z',
  sectionCount: 1,
  questionCount: 2,
  sections: [
    {
      number: 1,
      title: 'Morale',
      description: 'How you feel',
      questions: [
        {
          number: '1.1',
          key: 'overall',
          prompt: 'Rate your morale',
          type: 'likert',
          typeLabel: 'Likert',
          required: true,
          weight: 0.5,
          guidelines: 'Be honest',
          tags: ['Wellbeing'],
          options: ['1 — Low', '2 — Mid', '3 — High'],
          constraint: 'Scale 1 (Low) to 3 (High)',
        },
        {
          number: '1.2',
          key: 'formula',
          // Leading '=' must be neutralised in CSV.
          prompt: '=HYPERLINK("evil")',
          type: 'free_text',
          typeLabel: 'Free text',
          required: false,
          weight: 0.5,
          guidelines: null,
          tags: [],
          options: [],
          constraint: null,
        },
      ],
    },
  ],
};

describe('buildInstrumentText', () => {
  it('renders a header and numbered questions with options + guidance', () => {
    const txt = buildInstrumentText(MODEL);
    expect(txt).toContain('Staff Morale');
    expect(txt).toContain('Questionnaire (blank form)');
    expect(txt).toContain('Goal: Understand morale');
    expect(txt).toContain('1. Morale');
    expect(txt).toContain('1.1  Rate your morale  [Likert, required]');
    expect(txt).toContain('• 1 — Low');
    expect(txt).toContain('Guidance: Be honest');
    expect(txt).toContain('Tags: Wellbeing');
    expect(txt.endsWith('\n')).toBe(true);
  });
});

describe('buildInstrumentCsv', () => {
  it('emits a header row and one row per question', () => {
    const csv = buildInstrumentCsv(MODEL);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'section_number,section_title,question_number,key,prompt,type,required,weight,options,constraint,guidelines,tags'
    );
    expect(lines).toHaveLength(3); // header + 2 questions
    expect(lines[1]).toContain('overall');
    expect(lines[1]).toContain('1 — Low | 2 — Mid | 3 — High');
  });

  it('neutralises a formula-injection prompt', () => {
    const csv = buildInstrumentCsv(MODEL);
    // The '=' cell is prefixed with a single quote and RFC-4180 quoted (contains quotes).
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(csv).not.toContain(',=HYPERLINK');
  });
});
