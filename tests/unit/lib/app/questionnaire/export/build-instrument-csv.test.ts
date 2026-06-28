/**
 * build-instrument-csv — unit tests for the blank-instrument CSV serialiser (F14.9).
 *
 * Pins: the 12-column header row and its order, one data row per question across all sections,
 * column-value mapping (required yes/no, weight as plain numeric string, options pipe-joined,
 * tags comma-joined, null constraint/guidelines as empty cells), RFC 4180 quoting for commas /
 * embedded quotes / newlines inside cell values, formula-injection neutralisation (=, +, @, etc.),
 * CRLF line endings, and safe degradation for instruments with no sections or no questions.
 *
 * Pure: buildInstrumentCsv has no I/O or external dependencies — no mocking needed.
 *
 * @see lib/app/questionnaire/export/build-instrument-csv.ts
 */

import { describe, it, expect } from 'vitest';

import { buildInstrumentCsv } from '@/lib/app/questionnaire/export/build-instrument-csv';
import type {
  InstrumentModel,
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

// ─── fixtures ────────────────────────────────────────────────────────────────

function question(over: Partial<InstrumentQuestion> = {}): InstrumentQuestion {
  return {
    number: '1.1',
    key: 'q1',
    prompt: 'Sample prompt',
    type: 'free_text',
    typeLabel: 'Free text',
    required: false,
    weight: 0.5,
    guidelines: null,
    tags: [],
    options: [],
    constraint: null,
    ...over,
  };
}

function section(over: Partial<InstrumentSection> = {}): InstrumentSection {
  return {
    number: 1,
    title: 'Section One',
    description: null,
    questions: [question()],
    ...over,
  };
}

function model(over: Partial<InstrumentModel> = {}): InstrumentModel {
  return {
    title: 'Test Questionnaire',
    versionNumber: 1,
    goal: null,
    audienceSummary: null,
    generatedAt: '2026-06-28T00:00:00.000Z',
    sectionCount: 1,
    questionCount: 1,
    sections: [section()],
    ...over,
  };
}

const HEADER =
  'section_number,section_title,question_number,key,prompt,type,required,weight,options,constraint,guidelines,tags';

// ─── tests ───────────────────────────────────────────────────────────────────

describe('buildInstrumentCsv', () => {
  describe('header row', () => {
    it('emits all 12 column headers in the documented order on the first row', () => {
      const csv = buildInstrumentCsv(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      expect(csv.split('\r\n')[0]).toBe(HEADER);
    });

    it('places section context columns to the left of question columns', () => {
      const cols = buildInstrumentCsv(model()).split('\r\n')[0].split(',');
      expect(cols.indexOf('section_number')).toBeLessThan(cols.indexOf('question_number'));
      expect(cols.indexOf('section_title')).toBeLessThan(cols.indexOf('key'));
    });
  });

  describe('row count', () => {
    it('produces only the header row when the instrument has no sections', () => {
      const csv = buildInstrumentCsv(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      const rows = csv.trimEnd().split('\r\n');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(HEADER);
    });

    it('produces only the header row when a section exists but has no questions', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [] })], questionCount: 0 })
      );
      expect(csv.trimEnd().split('\r\n')).toHaveLength(1);
    });

    it('produces one data row per question across all sections', () => {
      const csv = buildInstrumentCsv(
        model({
          sectionCount: 2,
          questionCount: 3,
          sections: [
            section({
              number: 1,
              questions: [question({ number: '1.1' }), question({ key: 'q2', number: '1.2' })],
            }),
            section({
              number: 2,
              title: 'Second',
              questions: [question({ key: 'q3', number: '2.1' })],
            }),
          ],
        })
      );
      // header + 3 data rows
      expect(csv.trimEnd().split('\r\n')).toHaveLength(4);
    });
  });

  describe('column values', () => {
    it('encodes section_number as the 1-based integer converted to string', () => {
      const csv = buildInstrumentCsv(model({ sections: [section({ number: 3, title: 'Third' })] }));
      const firstData = csv.trimEnd().split('\r\n')[1];
      expect(firstData.startsWith('3,')).toBe(true);
    });

    it('places section_title in the second CSV column', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ number: 1, title: 'Background Info' })] })
      );
      const firstData = csv.trimEnd().split('\r\n')[1];
      expect(firstData.startsWith('1,Background Info,')).toBe(true);
    });

    it('places the question display number in the question_number column', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ number: '2.3' })] })] })
      );
      // question_number is column index 2 (0-based); this fixture row has no quoted cells
      const firstData = csv.trimEnd().split('\r\n')[1];
      const cols = firstData.split(',');
      expect(cols[2]).toBe('2.3');
    });

    it('encodes required=true as the literal string "yes"', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ required: true })] })] })
      );
      expect(csv).toContain(',yes,');
    });

    it('encodes required=false as the literal string "no"', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ required: false })] })] })
      );
      expect(csv).toContain(',no,');
    });

    it('encodes weight as a plain numeric string (not JSON-serialised)', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ weight: 0.75 })] })] })
      );
      expect(csv).toContain(',0.75,');
    });

    it('joins multiple options with " | " as the separator', () => {
      const csv = buildInstrumentCsv(
        model({
          sections: [section({ questions: [question({ options: ['Alpha', 'Beta', 'Gamma'] })] })],
        })
      );
      expect(csv).toContain('Alpha | Beta | Gamma');
    });

    it('emits a single option with no separator', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ options: ['Only Option'] })] })] })
      );
      expect(csv).toContain('Only Option');
      expect(csv).not.toContain(' | ');
    });

    it('renders a null constraint as an empty cell — not the string "null"', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ constraint: null })] })] })
      );
      // constraint is column index 9 (0-based); this fixture row has no quoted cells
      const firstData = csv.trimEnd().split('\r\n')[1];
      const cols = firstData.split(',');
      expect(cols[9]).toBe('');
    });

    it('renders a null guidelines as an empty cell — not the string "null"', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ guidelines: null })] })] })
      );
      // guidelines is column index 10 (0-based); this fixture row has no quoted cells
      const firstData = csv.trimEnd().split('\r\n')[1];
      const cols = firstData.split(',');
      expect(cols[10]).toBe('');
    });

    it('joins multiple tags with ", " so the combined cell is RFC-quoted', () => {
      const csv = buildInstrumentCsv(
        model({
          sections: [section({ questions: [question({ tags: ['Wellbeing', 'Culture'] })] })],
        })
      );
      // "Wellbeing, Culture" contains a comma → csvEscape wraps in double quotes
      expect(csv).toContain('"Wellbeing, Culture"');
    });

    it('emits a single tag without RFC quoting when the value contains no special chars', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ tags: ['Wellbeing'] })] })] })
      );
      // No quoting around a simple single-word tag
      expect(csv).toContain(',Wellbeing\r\n');
    });
  });

  describe('line endings', () => {
    it('uses CRLF (\\r\\n) as the row separator', () => {
      // header + 1 data row + trailing CRLF → split yields exactly 3 parts
      const csv = buildInstrumentCsv(model());
      expect(csv.split('\r\n')).toHaveLength(3);
    });

    it('ends with a trailing CRLF', () => {
      expect(buildInstrumentCsv(model()).endsWith('\r\n')).toBe(true);
    });

    it('ends with a trailing CRLF even for an instrument with no sections', () => {
      const csv = buildInstrumentCsv(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      expect(csv.endsWith('\r\n')).toBe(true);
    });
  });

  describe('RFC 4180 quoting', () => {
    it('wraps a cell containing a comma in double quotes', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ prompt: 'Age, in years' })] })] })
      );
      expect(csv).toContain('"Age, in years"');
    });

    it('wraps a cell containing embedded double quotes and doubles those quotes', () => {
      const csv = buildInstrumentCsv(
        model({
          sections: [section({ questions: [question({ prompt: 'He said "hello"' })] })],
        })
      );
      expect(csv).toContain('"He said ""hello"""');
    });

    it('wraps a cell containing a newline in double quotes', () => {
      const csv = buildInstrumentCsv(
        model({
          sections: [section({ questions: [question({ guidelines: 'Line one\nLine two' })] })],
        })
      );
      expect(csv).toContain('"Line one\nLine two"');
    });
  });

  describe('formula-injection neutralisation', () => {
    it('prefixes a cell starting with "=" with a single quote and RFC-quotes the result', () => {
      const csv = buildInstrumentCsv(
        model({
          sections: [section({ questions: [question({ prompt: '=HYPERLINK("evil")' })] })],
        })
      );
      // neutralised to "'=HYPERLINK(\"evil\")" → contains double-quotes → RFC-quoted with doubles escaped
      expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
      // The raw "=" must not appear at a cell boundary
      expect(csv).not.toContain(',=HYPERLINK');
    });

    it('prefixes a cell starting with "+" with a single quote', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ prompt: '+1234' })] })] })
      );
      expect(csv).toContain("'+1234");
      // Raw +1234 must not appear at the cell boundary
      expect(csv).not.toContain(',+1234');
    });

    it('prefixes a cell starting with "@" with a single quote', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ prompt: '@SUM(A1:A10)' })] })] })
      );
      expect(csv).toContain("'@SUM(A1:A10)");
    });

    it('does not add a quote prefix to a cell starting with a plain letter', () => {
      const csv = buildInstrumentCsv(
        model({ sections: [section({ questions: [question({ prompt: 'Normal prompt' })] })] })
      );
      expect(csv).toContain('Normal prompt');
      expect(csv).not.toContain("'Normal");
    });
  });

  describe('multi-section output order', () => {
    it('writes section 1 questions before section 2 questions', () => {
      const csv = buildInstrumentCsv(
        model({
          sectionCount: 2,
          questionCount: 2,
          sections: [
            section({
              number: 1,
              title: 'First',
              questions: [question({ key: 'alpha', number: '1.1' })],
            }),
            section({
              number: 2,
              title: 'Second',
              questions: [question({ key: 'beta', number: '2.1' })],
            }),
          ],
        })
      );
      const rows = csv.trimEnd().split('\r\n');
      expect(rows[1]).toContain('alpha');
      expect(rows[2]).toContain('beta');
    });
  });
});
