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
import type {
  PackModel,
  PackScopeEvaluation,
} from '@/lib/app/questionnaire/export/build-pack-model';
import type {
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

/** The empty scope-evaluation state — reused by every adaptive-scope fixture that isn't testing
 *  the evaluation blocks themselves. */
const EMPTY_SCOPE_EVALUATION: PackScopeEvaluation = {
  hasRun: false,
  runAt: null,
  totalFindings: 0,
  scores: [],
  targets: [],
};

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
    // The gate-off default: with `questionFidelity.enabled` false every question resolves to
    // `balanced`, and the model reports null so no renderer prints a uniform column.
    fidelity: null,
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
      adaptiveScope: false,
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
    adaptiveScope: null,
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

    it('renders both blocks after Definitions, with fixed headers, even with no run yet', () => {
      const csv = buildPackCsv(
        model({
          evaluations: { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] },
        })
      );
      const definitionsIdx = csv.indexOf('# Definitions');
      const scoresIdx = csv.indexOf('# Judge scores');
      const evaluationIdx = csv.indexOf('# Evaluation');
      expect(definitionsIdx).toBeGreaterThan(-1);
      expect(definitionsIdx).toBeLessThan(scoresIdx);
      expect(scoresIdx).toBeLessThan(evaluationIdx);
      expect(csv).toContain('dimension,judge,score,diagnostic,finding_count');
      expect(csv).toContain(
        'target_key,target_context,target,target_type,dimension,judge,severity,status,proposed_change,rationale,source_quote'
      );
    });

    it('puts each judge score on its own row in the scoreboard block', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 0,
            scores: [
              {
                dimension: 'clarity',
                label: 'Clarity Judge',
                score: 0.75,
                diagnostic: null,
                findingCount: 2,
              },
              {
                dimension: 'coverage',
                label: 'Coverage Judge',
                score: null,
                diagnostic: 'judge_error',
                findingCount: 0,
              },
            ],
            targets: [],
          },
        })
      );
      expect(csv).toContain('clarity,Clarity Judge,0.75,,2');
      // A failed judge keeps its row: blank score, diagnostic carried.
      expect(csv).toContain('coverage,Coverage Judge,,judge_error,0');
    });

    it('emits one row per (target, judge) with the target columns first', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 2,
            scores: [],
            targets: [
              {
                key: 'q1',
                context: 'Q1 · Background',
                label: 'Are you engaged and satisfied?',
                questionType: 'free_text',
                gap: false,
                removed: false,
                counts: { major: 1, minor: 1, info: 0, total: 2 },
                judgeCount: 2,
                alternatives: [],
                unresolvedBy: [],
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'major',
                    status: 'pending',
                    proposedChange: 'Split into two questions',
                    rationale: 'Asks two things at once',
                    sourceQuote: 'both engaged and satisfied',
                  },
                  {
                    dimension: 'audience_match',
                    label: 'Audience-Match Judge',
                    severity: 'minor',
                    status: 'declined',
                    proposedChange: 'Drop the jargon',
                    rationale: 'Too technical',
                    sourceQuote: null,
                  },
                ],
              },
            ],
          },
        })
      );
      expect(csv).toContain(
        'q1,Q1 · Background,Are you engaged and satisfied?,free_text,clarity,Clarity Judge,major,pending,Split into two questions,Asks two things at once,both engaged and satisfied'
      );
      // Unlike the PDF/Markdown packs, the target text DOES repeat per row — a CSV row has to
      // survive a sort or a pivot on its own, so blanking continuation rows would break it.
      expect(csv).toContain(
        'q1,Q1 · Background,Are you engaged and satisfied?,free_text,audience_match,Audience-Match Judge,minor,declined,Drop the jargon,Too technical,'
      );
    });

    it('emits the reconciled rewordings as their own block, one row per phrasing', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 1,
            scores: [],
            targets: [
              {
                key: 'q1',
                context: 'Q1 · Background',
                label: 'Are you engaged and satisfied?',
                questionType: 'free_text',
                gap: false,
                removed: false,
                counts: { major: 1, minor: 0, info: 0, total: 1 },
                judgeCount: 1,
                alternatives: [
                  {
                    prompt: 'How engaged do you feel at work?',
                    addresses: ['Clarity Judge', 'Audience-Match Judge'],
                    note: 'One ask.',
                  },
                ],
                unresolvedBy: ['Type-Fit Judge'],
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'major',
                    status: 'pending',
                    proposedChange: 'Split it',
                    rationale: 'Two asks',
                    sourceQuote: null,
                  },
                ],
              },
            ],
          },
        })
      );

      // Its own block, not extra columns on the findings rows — folding them together would
      // duplicate every judge row or leave most of them blank.
      expect(csv).toContain('# Suggested rewordings');
      expect(csv).toContain(
        'target_key,current_wording,suggested_wording,addresses,note,unresolved'
      );
      expect(csv).toContain(
        'q1,Are you engaged and satisfied?,How engaged do you feel at work?,Clarity Judge; Audience-Match Judge,One ask.,Type-Fit Judge'
      );
    });

    it('neutralises a formula-injection proposedChange via csvEscape', () => {
      const csv = buildPackCsv(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 1,
            scores: [],
            targets: [
              {
                key: 'q1',
                context: null,
                label: 'Q1',
                questionType: null,
                gap: false,
                removed: false,
                counts: { major: 0, minor: 1, info: 0, total: 1 },
                judgeCount: 1,
                alternatives: [],
                unresolvedBy: [],
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'minor',
                    status: 'pending',
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

  describe('adaptive scope blocks', () => {
    it('omits every adaptive scope block when the model field is null', () => {
      const csv = buildPackCsv(model({ adaptiveScope: null }));
      expect(csv).not.toContain('# Adaptive scope');
    });

    it('renders the summary, topics, and rules blocks after Definitions', () => {
      const csv = buildPackCsv(
        model({
          adaptiveScope: {
            enabled: true,
            alwaysAskedTopics: [
              {
                key: 'background',
                label: 'Background',
                description: null,
                alwaysAsked: true,
                criteria: null,
                sampledOnly: false,
              },
            ],
            conditionalTopics: [
              {
                key: 'talent',
                label: 'Talent & culture',
                description: 'Hiring and retention.',
                alwaysAsked: false,
                criteria: 'Mentions hiring difficulty.',
                sampledOnly: false,
              },
            ],
            rules: [{ sentence: 'Always include "Talent & culture" when "Engagement" exists.' }],
            maxConditionalTopics: 3,
            includeCheckTopic: true,
            sessionBudgetSeconds: 600,
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      const definitionsIdx = csv.indexOf('# Definitions');
      const summaryIdx = csv.indexOf('# Adaptive scope');
      const topicsIdx = csv.indexOf('# Adaptive scope topics');
      const rulesIdx = csv.indexOf('# Adaptive scope rules');
      expect(definitionsIdx).toBeGreaterThan(-1);
      expect(definitionsIdx).toBeLessThan(summaryIdx);
      expect(summaryIdx).toBeLessThan(topicsIdx);
      expect(topicsIdx).toBeLessThan(rulesIdx);
      expect(csv).toContain('Enabled,yes');
      expect(csv).toContain('key,label,description,always_asked,criteria,sampled_only');
      expect(csv).toContain('background,Background,,yes,,no');
      expect(csv).toContain(
        'talent,Talent & culture,Hiring and retention.,no,Mentions hiring difficulty.,no'
      );
      expect(csv).toContain('"Always include ""Talent & culture"" when ""Engagement"" exists."');
    });

    it('reports "no" for enabled and "no limit set" for an unset session budget', () => {
      const csv = buildPackCsv(
        model({
          adaptiveScope: {
            enabled: false,
            alwaysAskedTopics: [],
            conditionalTopics: [],
            rules: [],
            maxConditionalTopics: 3,
            includeCheckTopic: false,
            sessionBudgetSeconds: 0,
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(csv).toContain('Enabled,no');
      expect(csv).toContain('no limit set');
    });
  });

  describe('scope evaluation blocks', () => {
    const baseScope = {
      enabled: true,
      alwaysAskedTopics: [],
      conditionalTopics: [],
      rules: [],
      maxConditionalTopics: 3,
      includeCheckTopic: false,
      sessionBudgetSeconds: 0,
    };

    it('renders header-only score/finding blocks when the version has never been scope-evaluated', () => {
      const csv = buildPackCsv(
        model({ adaptiveScope: { ...baseScope, evaluation: EMPTY_SCOPE_EVALUATION } })
      );
      expect(csv).toContain('# Scope evaluation judge scores');
      expect(csv).toContain('# Scope evaluation findings');
      expect(csv).toContain(
        'dimension,judge,score,diagnostic,finding_count\r\n\r\n# Scope evaluation findings'
      );
    });

    it('renders one row per (target, judge) pair, repeating the target text down the rows', () => {
      const evaluation: PackScopeEvaluation = {
        hasRun: true,
        runAt: '2026-08-10T00:00:05.000Z',
        totalFindings: 1,
        scores: [
          {
            dimension: 'criteria_quality',
            label: 'Criteria-Quality Judge',
            score: 0.7,
            diagnostic: null,
            findingCount: 1,
          },
        ],
        targets: [
          {
            key: 'talent',
            kind: 'topic',
            label: 'Talent & culture',
            removed: false,
            counts: { major: 1, minor: 0, info: 0, total: 1 },
            judges: [
              {
                dimension: 'criteria_quality',
                label: 'Criteria-Quality Judge',
                severity: 'major',
                status: 'pending',
                proposedChange: 'Make the criteria more specific',
                rationale: 'Too broad to reliably trigger this topic',
                sourceQuote: null,
                proposedEditSummary: 'Rewrite the topic’s criteria',
              },
            ],
          },
        ],
      };
      const csv = buildPackCsv(model({ adaptiveScope: { ...baseScope, evaluation } }));
      expect(csv).toContain(
        'target_key,target_kind,target,target_removed,dimension,judge,severity,status,proposed_change,rationale,proposed_edit,source_quote'
      );
      expect(csv).toContain(
        'talent,topic,Talent & culture,no,criteria_quality,Criteria-Quality Judge,major,pending,Make the criteria more specific,Too broad to reliably trigger this topic,Rewrite the topic’s criteria,'
      );
    });
  });
});

/**
 * Question fidelity in the export.
 *
 * Two properties, and the first is the one that matters: a version that never turned the gate on
 * must produce byte-for-byte the document it produced before the field existed.
 */
describe('buildPackCsv — question fidelity', () => {
  it('keeps the column but leaves the cell empty when the gate is off', () => {
    const out = buildPackCsv(model({ sections: [section({ questions: [question()] })] }));
    // The header stays regardless so the CSV shape is stable for a spreadsheet
    // consumer; only the value is absent.
    expect(out).toMatch(/fidelity/);
    expect(out).not.toMatch(/Must ask/);
  });

  it('names the level when the gate is on', () => {
    const out = buildPackCsv(
      model({ sections: [section({ questions: [question({ fidelity: 'must_ask' })] })] })
    );
    expect(out).toMatch(/Must ask/);
  });
});
