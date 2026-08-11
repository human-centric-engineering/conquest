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
    include: {
      meta: true,
      questions: true,
      dataSlots: true,
      definitions: true,
      setup: true,
      setupTechnical: false,
      evaluations: false,
    },
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
    setup: [{ group: 'Access & participation', label: 'Access', value: 'Public link' }],
    evaluations: null,
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

  it('renders the experience-setup block with a group column, one flat table', () => {
    const csv = buildPackCsv(
      model({
        setup: [
          { group: 'Access & participation', label: 'Access', value: 'Public link' },
          { group: 'Reports', label: 'Respondent report', value: 'Enabled' },
        ],
      })
    );
    expect(csv).toContain('group,field,value');
    expect(csv).toContain('Access & participation,Access,Public link');
    expect(csv).toContain('Reports,Respondent report,Enabled');
    // A single header row — the groups are a column, not separate blocks.
    expect(csv.split('group,field,value').length - 1).toBe(1);
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

  describe('evaluations block', () => {
    it('omits the block entirely when the model field is null', () => {
      const csv = buildPackCsv(model({ evaluations: null }));
      expect(csv).not.toContain('# Evaluation');
    });

    it('renders after Definitions, with the fixed header row, even with zero dimensions (no run yet)', () => {
      const csv = buildPackCsv(
        model({ evaluations: { hasRun: false, runAt: null, totalFindings: 0, dimensions: [] } })
      );
      const definitionsIdx = csv.indexOf('# Definitions');
      const evaluationIdx = csv.indexOf('# Evaluation');
      expect(definitionsIdx).toBeGreaterThan(-1);
      expect(definitionsIdx).toBeLessThan(evaluationIdx);
      expect(csv).toContain(
        'dimension,judge,score,diagnostic,severity,status,target,proposed_change,rationale,source_quote'
      );
    });

    it('emits one row per finding, with the dimension score/diagnostic repeated on each', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 1,
            dimensions: [
              {
                dimension: 'clarity',
                label: 'Clarity Judge',
                score: 0.75,
                diagnostic: null,
                findings: [
                  {
                    severity: 'major',
                    status: 'pending',
                    targetLabel: 'Q1',
                    proposedChange: 'Split into two questions',
                    rationale: 'Asks two things at once',
                    sourceQuote: 'both engaged and satisfied',
                  },
                ],
              },
            ],
          },
        })
      );
      expect(csv).toContain(
        'clarity,Clarity Judge,0.75,,major,pending,Q1,Split into two questions,Asks two things at once,both engaged and satisfied'
      );
    });

    it('emits one summary-only row (blank finding columns) for a clean dimension with zero findings', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 0,
            dimensions: [
              {
                dimension: 'ordering',
                label: 'Ordering Judge',
                score: 1,
                diagnostic: null,
                findings: [],
              },
            ],
          },
        })
      );
      expect(csv).toContain('ordering,Ordering Judge,1,,,,,,,');
    });

    it('leaves the score column blank and carries the diagnostic when a judge failed', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 0,
            dimensions: [
              {
                dimension: 'coverage',
                label: 'Coverage Judge',
                score: null,
                diagnostic: 'judge_error',
                findings: [],
              },
            ],
          },
        })
      );
      expect(csv).toContain('coverage,Coverage Judge,,judge_error,,,,,,');
    });

    it('neutralises a formula-injection proposedChange via csvEscape', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 1,
            dimensions: [
              {
                dimension: 'clarity',
                label: 'Clarity Judge',
                score: 0.5,
                diagnostic: null,
                findings: [
                  {
                    severity: 'minor',
                    status: 'pending',
                    targetLabel: 'Q1',
                    proposedChange: '=HYPERLINK("evil")',
                    rationale: 'r',
                    sourceQuote: null,
                  },
                ],
              },
            ],
          },
        })
      );
      expect(csv).not.toContain(',=HYPERLINK');
      expect(csv).toContain("'=HYPERLINK");
    });
  });
});
