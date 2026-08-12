/**
 * build-pack-markdown — unit tests for the Questionnaire Pack Markdown serialiser.
 *
 * Pins: heading levels for each section, GFM tables for setup/data-slots, per-question rendering
 * (prompt/flags/constraint/options/guidance), that excluded (null) sections render nothing, table
 * cells are pipe-escaped, and the closing "About ConQuest" blurb + website link always appear.
 *
 * @see lib/app/questionnaire/export/build-pack-markdown.ts
 */

import { describe, it, expect } from 'vitest';

import { buildPackMarkdown } from '@/lib/app/questionnaire/export/build-pack-markdown';
import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
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
    required: true,
    weight: 0.5,
    guidelines: 'Be concise',
    tags: ['Culture'],
    options: [],
    constraint: null,
    ...over,
  };
}

function section(over: Partial<InstrumentSection> = {}): InstrumentSection {
  return {
    number: 1,
    title: 'Section One',
    description: 'A description',
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
        questions: [
          { key: 'q1', prompt: 'Sample prompt' },
          { key: 'q2', prompt: 'Second prompt' },
        ],
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

describe('buildPackMarkdown', () => {
  it('renders the title as an H1 and each section as its own H2', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('# Test Pack');
    expect(md).toContain('## Overview');
    expect(md).toContain('## Experience setup');
    expect(md).toContain('## Data slots');
    expect(md).toContain('## Questions');
    expect(md).toContain('## Definitions');
  });

  it('omits a heading entirely when its model field is null', () => {
    const md = buildPackMarkdown(
      model({ meta: null, dataSlots: null, glossary: null, setup: null })
    );
    expect(md).not.toContain('## Overview');
    expect(md).not.toContain('## Data slots');
    expect(md).not.toContain('## Definitions');
    expect(md).not.toContain('## Experience setup');
    expect(md).toContain('## Questions');
  });

  it('renders the experience-setup summary as a GFM table', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('| Setting | Value |');
    expect(md).toContain('| Access | Public link |');
  });

  it('opens a fresh sub-heading and table per settings group, in arrival order', () => {
    const md = buildPackMarkdown(
      model({
        setup: [
          { group: 'Access & participation', label: 'Access', value: 'Public link' },
          { group: 'Access & participation', label: 'Anonymous respondents', value: 'No' },
          { group: 'Reports', label: 'Respondent report', value: 'Enabled' },
        ],
      })
    );
    const accessIdx = md.indexOf('### Access & participation');
    const reportsIdx = md.indexOf('### Reports');
    expect(accessIdx).toBeGreaterThan(-1);
    expect(reportsIdx).toBeGreaterThan(accessIdx);
    // One header pair per group, not per row — two groups here, so exactly two tables.
    expect(md.split('| Setting | Value |').length - 1).toBe(2);
    // The two same-group rows share the first table (no heading between them).
    expect(md.indexOf('| Anonymous respondents | No |')).toBeLessThan(reportsIdx);
  });

  it('renders data slots as a table with semicolon-joined linked-question prompts', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('| Engagement | Culture | Desc | Sample prompt; Second prompt |');
  });

  it('escapes a literal pipe character inside a table cell', () => {
    const md = buildPackMarkdown(
      model({
        dataSlots: [
          { key: 'ds1', name: 'A | B', description: 'x', theme: 'y', weight: 1, questions: [] },
        ],
      })
    );
    expect(md).toContain('A \\| B');
  });

  it('escapes a literal backslash before escaping pipes, so a pre-existing "\\|" cannot smuggle an unescaped table delimiter', () => {
    // Escaping order matters: escaping `|` alone would turn a value already containing `\|`
    // into `\\|` in the output — which a GFM parser reads as an escaped backslash followed by
    // an UNESCAPED pipe, breaking out of the cell.
    const md = buildPackMarkdown(
      model({
        dataSlots: [
          { key: 'ds1', name: 'A\\|B', description: 'x', theme: 'y', weight: 1, questions: [] },
        ],
      })
    );
    expect(md).toContain('A\\\\\\|B');
    expect(md).not.toContain('A\\\\|B');
  });

  it('renders each section as an H3 with its numbered questions', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('### 1. Section One');
    expect(md).toContain('**1.1. Sample prompt**');
    expect(md).toContain('_(Free text, required)_');
  });

  it('renders question options, constraint, and guidance as bullets', () => {
    const md = buildPackMarkdown(
      model({
        sections: [
          section({
            questions: [
              question({
                options: ['Red', 'Blue'],
                constraint: 'Pick one',
                guidelines: 'Think carefully',
              }),
            ],
          }),
        ],
      })
    );
    expect(md).toContain('- Pick one');
    expect(md).toContain('- Red');
    expect(md).toContain('- Blue');
    expect(md).toContain('- Guidance: Think carefully');
  });

  it('renders the definitions appendix under the glossary heading', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('**Engagement**');
    expect(md).toContain(': Commitment level');
  });

  it('numbers multiple definitions for the same term', () => {
    const md = buildPackMarkdown(
      model({
        glossary: {
          heading: 'Definitions',
          entries: [{ term: 'Engagement', definitions: ['Sense one', 'Sense two'] }],
        },
      })
    );
    expect(md).toContain('1. Sense one');
    expect(md).toContain('2. Sense two');
  });

  it('always renders the closing "About ConQuest" blurb and website link', () => {
    const md = buildPackMarkdown(
      model({ meta: null, dataSlots: null, glossary: null, setup: null, sections: null })
    );
    expect(md).toContain(`## ${PACK_BRAND.closingHeading}`);
    expect(md).toContain(PACK_BRAND.closingBlurb);
    expect(md).toContain(`https://${PACK_BRAND.website}`);
  });

  it('ends with a single trailing newline', () => {
    const md = buildPackMarkdown(model());
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('renders the empty-data-slots fallback when dataSlots is an empty array', () => {
    const md = buildPackMarkdown(model({ dataSlots: [] }));
    expect(md).toContain('## Data slots');
    expect(md).toContain('_This questionnaire has no data slots yet._');
    expect(md).not.toContain('| Slot | Theme | Description | Linked questions |');
  });

  it('renders the empty-sections fallback when sections is an empty array', () => {
    const md = buildPackMarkdown(model({ sections: [] }));
    expect(md).toContain('## Questions');
    expect(md).toContain('_This questionnaire has no sections yet._');
  });

  it('renders "(no questions)" for a section with zero questions and continues to the next section', () => {
    const md = buildPackMarkdown(
      model({
        sections: [
          section({ number: 1, title: 'Empty Section', questions: [] }),
          section({ number: 2, title: 'Populated Section' }),
        ],
        sectionCount: 2,
      })
    );
    expect(md).toContain('### 1. Empty Section');
    expect(md).toContain('_(no questions)_');
    expect(md).toContain('### 2. Populated Section');
    expect(md).toContain('**1.1. Sample prompt**');
  });

  it('omits the goal and audience lines when meta.goal and meta.audienceSummary are absent', () => {
    const md = buildPackMarkdown(model({ meta: { goal: null, audienceSummary: null } }));
    expect(md).toContain('## Overview');
    expect(md).not.toContain('**Goal:**');
    expect(md).not.toContain('**Audience:**');
    expect(md).toContain('**Contents:** 1 section(s), 1 question(s)');
  });

  it('renders a section heading with no trailing description line when description is absent', () => {
    const md = buildPackMarkdown(model({ sections: [section({ description: null })] }));
    expect(md).toContain('### 1. Section One');
    expect(md).not.toContain('A description');
  });

  it('labels an optional question as "optional" rather than "required"', () => {
    const md = buildPackMarkdown(
      model({ sections: [section({ questions: [question({ required: false })] })] })
    );
    expect(md).toContain('_(Free text, optional)_');
  });

  it('omits the guidance and tags bullets when a question has no guidelines and no tags', () => {
    const md = buildPackMarkdown(
      model({
        sections: [section({ questions: [question({ guidelines: null, tags: [] })] })],
      })
    );
    expect(md).not.toContain('- Guidance:');
    expect(md).not.toContain('- Tags:');
  });

  describe('evaluations appendix', () => {
    it('omits the Evaluation heading when the model field is null', () => {
      const md = buildPackMarkdown(model({ evaluations: null }));
      expect(md).not.toContain('## Evaluation');
    });

    it('renders after Definitions, right before the closing "About ConQuest" blurb', () => {
      const md = buildPackMarkdown(
        model({
          evaluations: { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] },
        })
      );
      const definitionsIdx = md.indexOf('## Definitions');
      const evaluationIdx = md.indexOf('## Evaluation');
      const closingIdx = md.indexOf(`## ${PACK_BRAND.closingHeading}`);
      expect(definitionsIdx).toBeGreaterThan(-1);
      expect(definitionsIdx).toBeLessThan(evaluationIdx);
      expect(evaluationIdx).toBeLessThan(closingIdx);
    });

    it('renders the "no run yet" fallback when hasRun is false', () => {
      const md = buildPackMarkdown(
        model({
          evaluations: { hasRun: false, runAt: null, totalFindings: 0, scores: [], targets: [] },
        })
      );
      expect(md).toContain('## Evaluation');
      expect(md).toContain('_No evaluation has been run for this version yet._');
    });

    it('renders the judge scoreboard, with a diagnostic line when a judge failed', () => {
      const md = buildPackMarkdown(
        model({
          evaluations: {
            hasRun: true,
            runAt: '2026-08-10T00:00:05.000Z',
            totalFindings: 0,
            scores: [
              {
                dimension: 'clarity',
                label: 'Clarity Judge',
                score: 0.82,
                diagnostic: null,
                findingCount: 0,
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
      expect(md).toContain('### Judge scores');
      expect(md).toContain('- **Clarity Judge** — 82% · 0 finding(s)');
      expect(md).toContain('- **Coverage Judge** — _unavailable: judge_error_');
      // Nothing was flagged, so there is no per-question section at all.
      expect(md).toContain('_No findings raised._');
    });

    it('prints a contested question ONCE, as one H3, with a bullet per judge beneath it', () => {
      const md = buildPackMarkdown(
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
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'major',
                    status: 'pending',
                    proposedChange: 'Split into two questions',
                    rationale: 'Asks two things at once',
                    sourceQuote: 'engaged and satisfied',
                  },
                  {
                    dimension: 'audience_match',
                    label: 'Audience-Match Judge',
                    severity: 'minor',
                    status: 'declined',
                    proposedChange: 'Drop the jargon',
                    rationale: 'Too technical for this audience',
                    sourceQuote: null,
                  },
                ],
              },
            ],
          },
        })
      );

      // The question is the heading, named once — the old by-judge layout printed it under
      // every judge that flagged it.
      const occurrences = md.split('Are you engaged and satisfied?').length - 1;
      expect(occurrences).toBe(1);
      expect(md).toContain('### Q1 · Background — Are you engaged and satisfied?');
      expect(md).toContain('_Type: free_text · 2 judge(s) · 1 major_');

      // Each judge is a bullet under that one heading, named (the missing fact under a
      // question heading is *which judge said this*).
      expect(md).toContain('- **Clarity Judge** [major · pending] — Split into two questions');
      expect(md).toContain('  Asks two things at once');
      expect(md).toContain('  > engaged and satisfied');
      expect(md).toContain('- **Audience-Match Judge** [minor · declined] — Drop the jargon');
    });

    it('flags a target that no longer exists in the questionnaire', () => {
      const md = buildPackMarkdown(
        model({
          evaluations: {
            hasRun: true,
            runAt: 'now',
            totalFindings: 1,
            scores: [],
            targets: [
              {
                key: 'gone',
                context: null,
                label: 'gone',
                questionType: null,
                gap: false,
                removed: true,
                counts: { major: 0, minor: 1, info: 0, total: 1 },
                judges: [
                  {
                    dimension: 'duplicates',
                    label: 'Duplicates Judge',
                    severity: 'minor',
                    status: 'pending',
                    proposedChange: 'Merge with q1',
                    rationale: 'Covers the same ground',
                    sourceQuote: null,
                  },
                ],
              },
            ],
          },
        })
      );
      expect(md).toContain('### gone');
      expect(md).toContain('no longer in the questionnaire');
    });
  });
});
