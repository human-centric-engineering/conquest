/**
 * build-pack-csv — unit tests for the Questionnaire Pack CSV serialiser.
 *
 * Pins: each included section renders as its own `# Heading` comment row + header row + data rows,
 * excluded (null) sections are omitted entirely, blocks are separated by a blank line, CSV cells go
 * through the shared `csvEscape` (comma/quote/formula-injection), and the document ends with a
 * trailing CRLF.
 *
 * @see lib/app/questionnaire/export/build-pack-csv.ts
 */

import { describe, it, expect } from 'vitest';

import { buildPackCsv } from '@/lib/app/questionnaire/export/build-pack-csv';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';
import type {
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

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

function model(over: Partial<PackModel> = {}): PackModel {
  return {
    title: 'Test Pack',
    versionNumber: 1,
    generatedAt: '2026-08-10T00:00:00.000Z',
    include: { meta: true, questions: true, dataSlots: true, definitions: true, setup: true },
    meta: { goal: 'A goal', audienceSummary: 'Everyone' },
    sections: [section()],
    sectionCount: 1,
    questionCount: 1,
    dataSlots: [
      {
        key: 'ds1',
        name: 'Engagement',
        description: 'Desc',
        theme: 'Culture',
        weight: 1,
        questions: [{ key: 'q1', prompt: 'Sample prompt' }],
      },
    ],
    glossary: {
      heading: 'Definitions',
      entries: [{ term: 'Engagement', definitions: ['Commitment level'] }],
    },
    setup: [{ label: 'Access', value: 'Public link' }],
    ...over,
  };
}

describe('buildPackCsv', () => {
  it('emits a block for every included section, in a fixed order', () => {
    const csv = buildPackCsv(model());
    const metaIdx = csv.indexOf('# Meta');
    const setupIdx = csv.indexOf('# Experience setup');
    const slotsIdx = csv.indexOf('# Data slots');
    const questionsIdx = csv.indexOf('# Questions');
    const definitionsIdx = csv.indexOf('# Definitions');

    for (const idx of [metaIdx, setupIdx, slotsIdx, questionsIdx, definitionsIdx]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(metaIdx).toBeLessThan(setupIdx);
    expect(setupIdx).toBeLessThan(slotsIdx);
    expect(slotsIdx).toBeLessThan(questionsIdx);
    expect(questionsIdx).toBeLessThan(definitionsIdx);
  });

  it('omits a block entirely when its model field is null', () => {
    const csv = buildPackCsv(model({ meta: null, dataSlots: null, glossary: null, setup: null }));
    expect(csv).not.toContain('# Meta');
    expect(csv).not.toContain('# Data slots');
    expect(csv).not.toContain('# Definitions');
    expect(csv).not.toContain('# Experience setup');
    expect(csv).toContain('# Questions');
  });

  it('separates consecutive blocks with a blank line', () => {
    const csv = buildPackCsv(
      model({ dataSlots: null, glossary: null, setup: null, sections: null })
    );
    // Only "# Meta" remains besides the fixed brand preamble block — assert the blank-line join.
    expect(csv).toContain('\r\n\r\n# Meta');
  });

  it('renders the meta block with title/version/goal/audience/counts', () => {
    const csv = buildPackCsv(model());
    expect(csv).toContain('Title,Test Pack');
    expect(csv).toContain('Version,1');
    expect(csv).toContain('Goal,A goal');
    expect(csv).toContain('Audience,Everyone');
  });

  it('renders one data-slot row per slot with pipe-joined linked-question prompts', () => {
    const csv = buildPackCsv(model());
    expect(csv).toContain('Engagement,Culture,Desc,1,Sample prompt');
  });

  it('renders one question row per question, sibling to the instrument CSV shape', () => {
    const csv = buildPackCsv(
      model({ sections: [section({ questions: [question({ prompt: 'Age, in years' })] })] })
    );
    expect(csv).toContain('"Age, in years"');
  });

  it('renders one definitions row per definition, term repeated across multiple senses', () => {
    const csv = buildPackCsv(
      model({
        glossary: {
          heading: 'Definitions',
          entries: [{ term: 'Engagement', definitions: ['Sense one', 'Sense two'] }],
        },
      })
    );
    expect(csv).toContain('Engagement,Sense one');
    expect(csv).toContain('Engagement,Sense two');
  });

  it('neutralises a formula-injection prompt via the shared csvEscape', () => {
    const csv = buildPackCsv(
      model({ sections: [section({ questions: [question({ prompt: '=HYPERLINK("evil")' })] })] })
    );
    expect(csv).not.toContain(',=HYPERLINK');
    expect(csv).toContain("'=HYPERLINK");
  });

  it('ends with a trailing CRLF', () => {
    expect(buildPackCsv(model()).endsWith('\r\n')).toBe(true);
  });

  it('still produces a document (brand preamble only) when every section is excluded', () => {
    const csv = buildPackCsv(
      model({ meta: null, dataSlots: null, glossary: null, setup: null, sections: null })
    );
    expect(csv.length).toBeGreaterThan(0);
    expect(csv).not.toContain('#');
  });
});
