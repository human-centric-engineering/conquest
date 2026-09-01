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
import { DEFAULT_PACK_INCLUDE } from '@/lib/app/questionnaire/export/build-pack-model';
import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type {
  PackInterviewerPolicy,
  PackModel,
  PackPolicyEvaluation,
  PackScopeEvaluation,
} from '@/lib/app/questionnaire/export/build-pack-model';
import type {
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

/** The empty scope-evaluation state — reused by every conditional-topics fixture that isn't testing
 *  the evaluation block itself. */
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
    required: true,
    weight: 0.5,
    guidelines: 'Be concise',
    tags: ['Culture'],
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
      evaluationVerdicts: true,
      evaluationJudgeDetail: true,
      evaluationRewordings: true,
      evaluationEvidence: true,
      conditionalTopics: false,
      conditionalTopicsMembers: true,
      conditionalTopicsEvaluation: true,
      conditionalTopicsTechnical: true,
      interviewerPolicy: false,
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
    conditionalTopics: null,
    interviewerPolicy: null,
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

    /* ---------------------------------------------------------------------- */
    /* The verdict, and the sub-options that decide how much of it prints      */
    /* ---------------------------------------------------------------------- */

    /** A contested question: two judges want a reword, one wants it gone. */
    const CONTESTED_TARGET = {
      key: 'q1',
      context: 'Q1 · Background',
      label: 'Are you engaged and satisfied?',
      questionType: 'free_text',
      routingReach: 'Asked when it fits',
      topicLabel: 'Onboarding',
      verdict: {
        contested: true,
        blocks: [
          {
            heading: 'A reword',
            backing: '2 of 3 judges',
            judges: 'Clarity, Audience-Match',
            holdsWording: true,
            suggestions: ['Reword to avoid the leading adjective.'],
          },
          {
            heading: 'A deletion',
            backing: '1 of 3 judges',
            judges: 'Duplicates',
            holdsWording: false,
            suggestions: ['Remove it, Q2 already covers this ground.'],
          },
        ],
      },
      gap: false,
      removed: false,
      counts: { major: 1, minor: 2, info: 0, total: 3 },
      judgeCount: 3,
      alternatives: [
        {
          prompt: 'How engaged do you feel at work?',
          addresses: ['Clarity Judge'],
          note: 'One ask.',
        },
      ],
      unresolvedBy: ['Type-Fit Judge'],
      judges: [
        {
          dimension: 'clarity' as const,
          label: 'Clarity Judge',
          severity: 'major' as const,
          status: 'pending' as const,
          proposedChange: 'Split into two questions',
          rationale: 'Asks two things at once',
          sourceQuote: 'engaged and satisfied',
          proposedEditSummary: "Replaces this question's wording with the suggested version.",
          destination: null,
          applyInstruction: 'Keep it under fifteen words.',
        },
      ],
    };

    function contested(over: Partial<PackModel['include']> = {}) {
      return buildPackMarkdown(
        model({
          include: { ...DEFAULT_PACK_INCLUDE, evaluations: true, ...over },
          evaluations: {
            hasRun: true,
            runAt: '2026-08-11T09:00:00.000Z',
            totalFindings: 3,
            scores: [],
            targets: [CONTESTED_TARGET],
          },
        })
      );
    }

    it('leads with what the panel wants done, and keeps the dissent', () => {
      const md = contested();
      expect(md).toContain('**A reword**, as proposed by 2 of 3 judges — Clarity, Audience-Match');
      // The dissent is the next heading down, not a footnote. A pack printing only the winner
      // would report a consensus the panel never reached.
      expect(md).toContain('**A deletion**, as proposed by 1 of 3 judges — Duplicates');
    });

    it('says who is actually asked the flagged question', () => {
      // The line joining the pack's two opt-in appendices: a reader weighing a deletion can see
      // that only some respondents ever reach this question.
      expect(contested()).toContain('Asked when it fits: Onboarding');
    });

    it('puts the wordings inside the block they answer, not under the leading action', () => {
      const md = contested();
      const rewordIdx = md.indexOf('**A reword**');
      const deletionIdx = md.indexOf('**A deletion**');
      const wordingIdx = md.indexOf('How engaged do you feel at work?');
      // Between the reword heading (which holds them) and the deletion heading below it. Under
      // "A deletion" they would read as the panel wanting the question deleted and rewritten.
      expect(wordingIdx).toBeGreaterThan(rewordIdx);
      expect(wordingIdx).toBeLessThan(deletionIdx);
    });

    it('prints the conclusions and not the arguments by default', () => {
      // The default download shape. The judge's own reasoning is the bulk of the appendix, and a
      // reader handed the pack usually wants what to do rather than four arguments for it.
      const md = contested();
      expect(md).toContain('**A reword**');
      expect(md).not.toContain('Asks two things at once');
      expect(md).not.toContain('> engaged and satisfied');
    });

    it('adds every judge’s reasoning, their edit, and the reviewer’s own words when asked', () => {
      const md = contested({ evaluationJudgeDetail: true });
      expect(md).toContain('**Clarity Judge** [Major] — Split into two questions');
      expect(md).toContain('Asks two things at once');
      expect(md).toContain("Replaces this question's wording with the suggested version.");
      expect(md).toContain("_Reviewer's instruction: Keep it under fifteen words._");
      // Evidence stays behind its own flag: judges routinely quote the prompt the finding already
      // sits under, so it is mostly the same sentence twice.
      expect(md).not.toContain('> engaged and satisfied');
    });

    it('adds the evidence quotes only when asked', () => {
      const md = contested({ evaluationJudgeDetail: true, evaluationEvidence: true });
      expect(md).toContain('> engaged and satisfied');
    });

    it('drops the verdict and the wordings when both are unticked', () => {
      const md = contested({ evaluationVerdicts: false, evaluationRewordings: false });
      expect(md).not.toContain('**A reword**');
      expect(md).not.toContain('How engaged do you feel at work?');
      // The subject and its tallies survive: the section still says what was flagged.
      expect(md).toContain('Are you engaged and satisfied?');
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
                routingReach: null,
                topicLabel: null,
                verdict: null,
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
                    sourceQuote: 'engaged and satisfied',
                    proposedEditSummary: null,
                    destination: null,
                    applyInstruction: null,
                  },
                  {
                    dimension: 'audience_match',
                    label: 'Audience-Match Judge',
                    severity: 'minor',
                    status: 'declined',
                    proposedChange: 'Drop the jargon',
                    rationale: 'Too technical for this audience',
                    sourceQuote: null,
                    proposedEditSummary: null,
                    destination: null,
                    applyInstruction: null,
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
      // The answer type in the reader's words, not the stored slug — the pack used to print
      // "Type: free_text" in a document written for a client.
      expect(md).toContain('_Type: Free text · 2 judge(s) · 1 major_');

      // Each judge is a bullet under that one heading, named (the missing fact under a
      // question heading is *which judge said this*).
      // Severity is labelled, and `pending` is dropped: it is the state of nearly every finding
      // in an untriaged run, so printing it on each line is a word to skip and nothing more. A
      // decision someone actually recorded still shows.
      expect(md).toContain('- **Clarity Judge** [Major] — Split into two questions');
      expect(md).toContain('  Asks two things at once');
      expect(md).toContain('  > engaged and satisfied');
      expect(md).toContain('- **Audience-Match Judge** [Minor · Declined] — Drop the jargon');
      expect(md).not.toContain('pending');
    });

    it('prints the rewordings after the judges when the verdict is unticked', () => {
      // The production route to the standalone-rewordings branch, which the fixture-level
      // `verdict: null` test below reaches artificially: `buildPackModel` cannot emit a target
      // that has judges and no verdict (a group always has at least one finding, so
      // `summariseGroupActions` always yields a primary). Only the include flag gets you here.
      const md = contested({ evaluationVerdicts: false, evaluationJudgeDetail: true });

      expect(md).not.toContain('**A reword**');
      expect(md).toContain('**Suggested rewording** (addressing the judges above):');
      expect(md).toContain('How engaged do you feel at work?');
      // And still after the judges, which is where they sat before verdicts existed and for the
      // reason that has not changed: a resolution only reads as one once you have seen the
      // disagreement it resolves.
      expect(md.indexOf('Asks two things at once')).toBeLessThan(
        md.indexOf('How engaged do you feel at work?')
      );
    });

    // test-review:accept mock-realism — `verdict: null` with populated judges is a state
    // `buildPackModel` cannot emit; these fixtures drive the serialiser's defensive fallback
    // directly. The realistic route (evaluationVerdicts: false) is covered by the test above.
    it('prints the reconciled rewording on its own when no verdict is there to host it', () => {
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
                routingReach: null,
                topicLabel: null,
                verdict: null,
                judgeCount: 1,
                alternatives: [
                  {
                    prompt: 'How engaged do you feel at work?',
                    addresses: ['Clarity Judge', 'Audience-Match Judge'],
                    note: 'One ask, plain language.',
                  },
                ],
                unresolvedBy: ['Type-Fit Judge'],
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'major',
                    status: 'pending',
                    proposedChange: 'Split into two questions',
                    rationale: 'Asks two things at once',
                    sourceQuote: null,
                    proposedEditSummary: null,
                    destination: null,
                    applyInstruction: null,
                  },
                ],
              },
            ],
          },
        })
      );

      // No verdict block to sit inside, so the wordings stand alone rather than being dropped —
      // a run from before the verdict step, or a download with verdicts unticked.
      expect(md).toContain('**Suggested rewording** (addressing the judges above):');
      expect(md).toContain('- How engaged do you feel at work?');
      expect(md).toContain(
        '_Addresses: Clarity Judge, Audience-Match Judge._ One ask, plain language.'
      );
      // The concern wording cannot fix is printed, not swallowed — otherwise the rewrite reads as
      // consensus the panel never reached.
      expect(md).toContain('Not resolved by rewording: Type-Fit Judge');

      // Order matters, and still does in this path: the reconciliation only makes sense after the
      // disagreement it resolves, so with no verdict to host it, it goes after the judges.
      expect(md.indexOf('Split into two questions')).toBeLessThan(
        md.indexOf('How engaged do you feel at work?')
      );
    });

    it('omits the rewording block entirely for a target with no alternatives', () => {
      const md = buildPackMarkdown(
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
                label: 'A question',
                questionType: null,
                gap: false,
                removed: false,
                counts: { major: 0, minor: 1, info: 0, total: 1 },
                routingReach: null,
                topicLabel: null,
                verdict: null,
                judgeCount: 1,
                alternatives: [],
                unresolvedBy: [],
                judges: [
                  {
                    dimension: 'clarity',
                    label: 'Clarity Judge',
                    severity: 'minor',
                    status: 'pending',
                    proposedChange: 'Tighten it',
                    rationale: 'Wordy',
                    sourceQuote: null,
                    proposedEditSummary: null,
                    destination: null,
                    applyInstruction: null,
                  },
                ],
              },
            ],
          },
        })
      );
      expect(md).not.toContain('Suggested rewording');
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
                routingReach: null,
                topicLabel: null,
                verdict: null,
                judgeCount: 1,
                alternatives: [],
                unresolvedBy: [],
                judges: [
                  {
                    dimension: 'duplicates',
                    label: 'Duplicates Judge',
                    severity: 'minor',
                    status: 'pending',
                    proposedChange: 'Merge with q1',
                    rationale: 'Covers the same ground',
                    sourceQuote: null,
                    proposedEditSummary: null,
                    destination: null,
                    applyInstruction: null,
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

  describe('conditional topics section', () => {
    it('omits the section entirely when the model field is null', () => {
      const md = buildPackMarkdown(model({ conditionalTopics: null }));
      expect(md).not.toContain('## Conditional topics');
    });

    it('states plainly that scope is not enabled, without listing topics', () => {
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: false,
            alwaysAsked: [
              {
                key: 'background',
                label: 'Background',
                description: null,
                alwaysAsked: true,
                criteria: null,
                sampledOnly: false,
                questions: [],
                trigger: null,
              },
            ],
            conditional: [],
            rules: [],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(md).toContain('## Conditional topics');
      expect(md).toContain(
        'Conditional topics is not enabled for this version — every respondent is asked the full instrument.'
      );
      expect(md).not.toContain('### Always asked');
      expect(md).not.toContain('Background');
    });

    it('lists always-asked and conditional topics under their own headings, with criteria on the conditional ones', () => {
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [
              {
                key: 'background',
                label: 'Background',
                description: 'The opening questions.',
                alwaysAsked: true,
                criteria: null,
                sampledOnly: false,
                questions: [],
                trigger: null,
              },
            ],
            conditional: [
              {
                key: 'talent',
                label: 'Talent & culture',
                description: 'Hiring and retention.',
                alwaysAsked: false,
                criteria: 'Mentions hiring difficulty.',
                sampledOnly: false,
                questions: [],
                trigger: null,
              },
              {
                key: 'compliance-check',
                label: 'Compliance blind-spot check',
                description: null,
                alwaysAsked: false,
                criteria: 'Sampled when nothing else pointed at compliance.',
                sampledOnly: true,
                questions: [],
                trigger: null,
              },
            ],
            rules: [],
            settings: [
              { label: 'Topics that depend on the respondent', value: 'Up to 3 per interview' },
              { label: 'Interview length', value: '10 min' },
              {
                label: 'Respondent can ask for another area',
                value: 'Yes, and it is added',
              },
            ],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(md).toContain('### Always asked');
      expect(md).toContain('**Background**');
      expect(md).toContain('The opening questions.');
      expect(md).toContain('### Asked when it fits');
      expect(md).toContain('**Talent & culture**');
      expect(md).toContain('_Included when: Mentions hiring difficulty._');
      expect(md).toContain(
        '**Compliance blind-spot check** _(sampled lightly, not asked in full)_'
      );
      // The settings render as a table from the routing registry, so this section can no longer
      // silently cover four of the fifteen routing settings.
      expect(md).toContain('| Topics that depend on the respondent | Up to 3 per interview |');
      expect(md).toContain('| Interview length | 10 min |');
      // What the respondent actually experiences — absent from the section entirely before.
      expect(md).toContain('| Respondent can ask for another area | Yes, and it is added |');
      // "Conditional topic" as a noun is not reintroduced right after teaching the reader
      // "asked when it fits".
      expect(md).not.toContain('conditional topic(s)');
    });

    it('lists the questions a topic covers, so a reader can see what is not asked', () => {
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [
              {
                key: 'talent',
                label: 'Talent & culture',
                description: null,
                alwaysAsked: false,
                criteria: 'Mentions hiring difficulty.',
                sampledOnly: false,
                questions: [
                  { key: 'q7', prompt: 'How easy is it to hire for your team?' },
                  { key: 'q8', prompt: 'What makes people stay?' },
                ],
                trigger: null,
              },
            ],
            rules: [],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );

      // The link the document could not previously make: topics in one section, questions in
      // another, and nothing saying which belongs to which.
      expect(md).toContain('  - How easy is it to hire for your team?');
      expect(md).toContain('  - What makes people stay?');
    });

    it('says when the source document wanted a topic triggered mid-conversation', () => {
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [
              {
                key: 'safeguarding',
                label: 'Safeguarding',
                description: null,
                alwaysAsked: false,
                criteria: 'The opening suggests vulnerability.',
                sampledOnly: false,
                questions: [],
                trigger: {
                  condition: 'The applicant discloses that they are fleeing abuse',
                  cues: ['abuse', 'fleeing'],
                },
              },
            ],
            rules: [],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );

      // Recorded, not acted on — and the document says which. Printing the criteria alone would
      // show the approximation as though it were what the document asked for.
      expect(md).toContain(
        'The source document asks for this when: The applicant discloses that they are fleeing abuse.'
      );
      // One full stop, not two — the builder trims the authored condition's own.
      expect(md).not.toContain('fleeing abuse..');
      expect(md).toContain('Today it is decided from the opening instead.');
      // The criteria that actually runs is still shown, above it.
      expect(md.indexOf('_Included when: The opening suggests vulnerability._')).toBeLessThan(
        md.indexOf('The source document asks for this when')
      );
    });

    it('renders hard rules under their own heading, and omits it when there are none', () => {
      const withRules = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [],
            rules: [{ sentence: 'Always include "Talent & culture" when "Engagement" exists.' }],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(withRules).toContain('### Hard rules');
      expect(withRules).toContain('Always include "Talent & culture" when "Engagement" exists.');

      const withoutRules = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [],
            rules: [],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(withoutRules).not.toContain('### Hard rules');
    });

    it('renders "None defined." under each heading when a version has no topics at all', () => {
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [],
            rules: [],
            settings: [],
            evaluation: EMPTY_SCOPE_EVALUATION,
          },
        })
      );
      expect(md).toContain('### Always asked');
      expect(md).toContain('### Asked when it fits');
      // Both sections render the same empty-state text.
      expect(md.match(/_None defined\._/g)).toHaveLength(2);
    });
  });

  describe('routing review subsection', () => {
    it('says nothing at all about the review when the admin excluded it', () => {
      // The bug this guards: rendering the excluded case as `hasRun: false` made the document
      // state "This routing has not been reviewed" about a version whose routing HAD been
      // reviewed. Silence is the only honest output for a section the admin left out.
      const md = buildPackMarkdown(
        model({
          conditionalTopics: {
            enabled: true,
            alwaysAsked: [],
            conditional: [],
            rules: [],
            settings: [],
            evaluation: null,
          },
        })
      );

      expect(md).toContain('## Conditional topics');
      expect(md).not.toContain('Review of this routing');
      expect(md).not.toContain('has not been reviewed');
    });

    const baseScope = {
      enabled: true,
      alwaysAsked: [],
      conditional: [],
      rules: [],
      settings: [],
    };

    it('renders the "no run yet" fallback under its own heading when hasRun is false', () => {
      const md = buildPackMarkdown(
        model({ conditionalTopics: { ...baseScope, evaluation: EMPTY_SCOPE_EVALUATION } })
      );
      // "Scope" is the pre-F17.29 name for this whole area; a stakeholder heading is the last
      // place it should survive.
      expect(md).toContain('### Review of this routing');
      expect(md).toContain('_This routing has not been reviewed._');
      expect(md).not.toContain('Scope evaluation');
    });

    it('renders the judge scoreboard and one finding grouped under its target', () => {
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
          {
            dimension: 'budget_realism',
            label: 'Budget-Realism Judge',
            score: null,
            diagnostic: 'judge_error',
            findingCount: 0,
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
      const md = buildPackMarkdown(model({ conditionalTopics: { ...baseScope, evaluation } }));
      expect(md).toContain('### Review of this routing');
      expect(md).toContain('Criteria-Quality Judge');
      expect(md).toContain('70%');
      expect(md).toContain('Budget-Realism Judge');
      expect(md).toContain('unavailable (judge_error)');
      expect(md).toContain('#### Talent & culture');
      expect(md).toContain('Make the criteria more specific');
      expect(md).toContain('Proposed edit: Rewrite the topic’s criteria');
    });
  });
});

/**
 * Question fidelity in the export.
 *
 * Two properties, and the first is the one that matters: a version that never turned the gate on
 * must produce byte-for-byte the document it produced before the field existed.
 */
describe('buildPackMarkdown — question fidelity', () => {
  it('renders nothing at all when the gate is off', () => {
    const out = buildPackMarkdown(model({ sections: [section({ questions: [question()] })] }));
    expect(out).not.toMatch(/fidelity/i);
    expect(out).not.toMatch(/must ask/i);
  });

  it('names the level when the gate is on', () => {
    const out = buildPackMarkdown(
      model({ sections: [section({ questions: [question({ fidelity: 'must_ask' })] })] })
    );
    expect(out).toMatch(/Must ask/);
  });
});

/* -------------------------------------------------------------------------- */
/* The interviewer policy appendix (F18.8)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The whole `interviewerPolicy` block was unrendered by any test, so every line of it — the
 * form-only short circuit, the arc bands, the house rules, the fidelity distribution and the
 * nested judge panel — could have been deleted without a suite failing.
 *
 * Each case below pins a *branch*, not just the happy path: the pairs (pace / no pace, rules /
 * no rules, gate on / gate off, reviewed / not reviewed) are what the section's meaning turns on.
 */
describe('buildPackMarkdown — the interviewer', () => {
  const EMPTY_POLICY_EVALUATION: PackPolicyEvaluation = {
    hasRun: false,
    runAt: null,
    totalFindings: 0,
    scores: [],
    targets: [],
  };

  function policy(over: Partial<PackInterviewerPolicy> = {}): PackInterviewerPolicy {
    return {
      conversational: true,
      houseRulesEnabled: true,
      houseRules: [
        { kind: 'Never', text: 'Never use humour.', trigger: null },
        { kind: 'If asked', text: 'Say who reads the answers.', trigger: 'privacy' },
      ],
      approachLabel: 'Funnel',
      paceLabel: 'Brisk',
      openingSource: 'Guided by the examples you wrote',
      tacticLabels: ['Probes shallow answers', 'Reflects answers back'],
      arcBands: [
        { label: 'Opening', detail: 'The first 1 question is broad and unhurried' },
        { label: 'Broad', detail: 'While less than 25% of the questionnaire is covered' },
      ],
      fidelityEnabled: true,
      fidelityDistribution: [
        { level: 'must_ask', label: 'Must ask', count: 2 },
        { level: 'balanced', label: 'Balanced', count: 0 },
      ],
      mustAskQuestions: [{ key: 'q1', prompt: 'Sample prompt' }],
      evaluation: EMPTY_POLICY_EVALUATION,
      ...over,
    };
  }

  it('renders nothing at all when the section is excluded', () => {
    expect(buildPackMarkdown(model())).not.toContain('## The interviewer');
  });

  it('renders above the closing "About ConQuest" blurb, not after it', () => {
    // It used to be appended after the sign-off, which put a whole appendix below the line where
    // the document says it has ended. Asserting the ORDER rather than mere presence is the point:
    // the previous tests all passed while the section was unreachable to a reader.
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));

    expect(md.indexOf('## The interviewer')).toBeGreaterThan(-1);
    expect(md.indexOf('## The interviewer')).toBeLessThan(md.indexOf('## About ConQuest'));
    // And the sign-off is genuinely last, so nothing else has slipped below it either.
    expect(md.trimEnd().endsWith('](https://conquestinsights.com)')).toBe(true);
  });

  it('renders the approach, pace, opening and tactics as a fact list', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));
    expect(md).toContain('## The interviewer');
    expect(md).toContain('**Questioning approach:** Funnel');
    expect(md).toContain('**Pace:** Brisk');
    expect(md).toContain('**Opening questions:** Guided by the examples you wrote');
    expect(md).toContain('**Tactics:** Probes shallow answers, Reflects answers back');
  });

  it('omits the pace and tactics lines rather than printing empties', () => {
    // Under Open or Targeted the runtime never reads a pace, so naming one would describe an arc
    // that is not running — the model sends null and the renderer must stay silent.
    const md = buildPackMarkdown(
      model({ interviewerPolicy: policy({ paceLabel: null, tacticLabels: [], arcBands: [] }) })
    );
    expect(md).not.toContain('**Pace:**');
    expect(md).not.toContain('**Tactics:**');
    expect(md).not.toContain('### How the questioning narrows');
  });

  it('renders the arc bands under their own heading when a funnel is running', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));
    expect(md).toContain('### How the questioning narrows');
    expect(md).toContain('- **Opening** — The first 1 question is broad and unhurried');
    expect(md).toContain('- **Broad** — While less than 25% of the questionnaire is covered');
  });

  it('says a form-only questionnaire has no interviewer, and prints none of the settings', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy({ conversational: false }) }));
    expect(md).toContain('filled in as a form, so none of the interviewer settings apply');
    // The short circuit must skip every setting below it, not merely the heading.
    expect(md).not.toContain('**Questioning approach:**');
    expect(md).not.toContain('### House rules');
    // ...but the review verdict still renders: it is about the setup, not about a live interview.
    expect(md).toContain('### Interviewer review');
  });

  it('prints an if-asked rule with its trigger and an always/never rule without one', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));
    expect(md).toContain('- **Never**: Never use humour.');
    expect(md).toContain(
      '- **If asked** _(when asked about: privacy)_: Say who reads the answers.'
    );
  });

  it('states that no house rules are in force rather than printing an empty list', () => {
    // Two ways to get here — the block switched off, or switched on with nothing in force — and
    // both must read the same to someone holding the document.
    for (const p of [
      policy({ houseRulesEnabled: false, houseRules: [] }),
      policy({ houseRulesEnabled: true, houseRules: [] }),
    ]) {
      const md = buildPackMarkdown(model({ interviewerPolicy: p }));
      expect(md).toContain('_No house rules are in force for this questionnaire._');
    }
  });

  it('lists only the fidelity levels that actually have questions', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));
    expect(md).toContain('- Must ask: 2');
    // A level nobody used is noise in a client-facing document, not information.
    expect(md).not.toContain('- Balanced: 0');
    expect(md).toContain('Put to the respondent word for word:');
    expect(md).toContain('- Sample prompt');
  });

  it('says every question is conversational while the fidelity gate is off', () => {
    const md = buildPackMarkdown(
      model({
        interviewerPolicy: policy({
          fidelityEnabled: false,
          fidelityDistribution: [],
          mustAskQuestions: [],
        }),
      })
    );
    expect(md).toContain('_Every question is asked conversationally._');
    expect(md).not.toContain('Put to the respondent word for word:');
  });

  it('omits the word-for-word list when the gate is on but no question is held to it', () => {
    const md = buildPackMarkdown(
      model({
        interviewerPolicy: policy({
          fidelityDistribution: [{ level: 'balanced', label: 'Balanced', count: 3 }],
          mustAskQuestions: [],
        }),
      })
    );
    expect(md).toContain('- Balanced: 3');
    expect(md).not.toContain('Put to the respondent word for word:');
  });

  it('states that the panel has not run rather than omitting the review section', () => {
    const md = buildPackMarkdown(model({ interviewerPolicy: policy() }));
    expect(md).toContain('### Interviewer review');
    expect(md).toContain('_This interviewer setup has not been reviewed._');
  });

  it('renders the review scores, falling back through diagnostic then "unavailable"', () => {
    const md = buildPackMarkdown(
      model({
        interviewerPolicy: policy({
          evaluation: {
            hasRun: true,
            runAt: '2026-08-11T00:00:00.000Z',
            totalFindings: 2,
            scores: [
              {
                dimension: 'rule_coherence',
                label: 'Rule-Coherence Judge',
                score: 0.82,
                diagnostic: null,
                findingCount: 1,
              },
              {
                dimension: 'arc_fit',
                label: 'Arc-Fit Judge',
                score: null,
                diagnostic: 'provider timed out',
                findingCount: 0,
              },
              {
                dimension: 'fidelity_calibration',
                label: 'Fidelity-Calibration Judge',
                score: null,
                diagnostic: null,
                findingCount: 0,
              },
            ],
            targets: [],
          },
        }),
      })
    );
    // UTC, named — otherwise the same run prints as a different DAY depending on which region's
    // server rendered the pack, on a document somebody may be reading as a record.
    expect(md).toContain('Reviewed 11 Aug 2026, 00:00 UTC · 2 finding(s).');
    expect(md).toContain('| Rule-Coherence Judge | 82% | 1 |');
    // A judge that could not score says why; one that has no reason to give says so plainly.
    expect(md).toContain('| Arc-Fit Judge | provider timed out | 0 |');
    expect(md).toContain('| Fidelity-Calibration Judge | unavailable | 0 |');
  });

  it('says the date is unknown when a completed run carries no timestamp', () => {
    const md = buildPackMarkdown(
      model({
        interviewerPolicy: policy({
          evaluation: {
            hasRun: true,
            runAt: null,
            totalFindings: 0,
            scores: [],
            targets: [],
          },
        }),
      })
    );
    expect(md).toContain('Reviewed date unknown · 0 finding(s).');
  });

  it('groups findings under their subject, marking one the author has since deleted', () => {
    const md = buildPackMarkdown(
      model({
        interviewerPolicy: policy({
          evaluation: {
            hasRun: true,
            runAt: '2026-08-11T00:00:00.000Z',
            totalFindings: 2,
            scores: [],
            targets: [
              {
                key: 'r1',
                kind: 'house_rule',
                label: 'Never use humour.',
                removed: false,
                counts: { major: 1, minor: 0, info: 0, total: 1 },
                judges: [
                  {
                    dimension: 'rule_coherence',
                    label: 'Rule-Coherence Judge',
                    severity: 'major',
                    status: 'pending',
                    proposedChange: 'Narrow this rule.',
                    rationale: 'It contradicts the always rule above it.',
                    sourceQuote: null,
                    proposedEditSummary: 'Set the rule text to "Avoid jokes about the company."',
                  },
                ],
              },
              {
                key: 'r2',
                kind: 'house_rule',
                label: 'A rule that no longer exists',
                removed: true,
                counts: { major: 0, minor: 1, info: 0, total: 1 },
                judges: [
                  {
                    dimension: 'cross_layer_conflict',
                    label: 'Cross-Layer-Conflict Judge',
                    severity: 'minor',
                    status: 'declined',
                    proposedChange: 'Drop it.',
                    rationale: 'Already gone.',
                    sourceQuote: null,
                    proposedEditSummary: null,
                  },
                ],
              },
            ],
          },
        }),
      })
    );
    expect(md).toContain('**Never use humour.**');
    // The reader must be able to tell a live subject from one the author has since deleted,
    // or they will go looking for a rule that is not there.
    expect(md).toContain('**A rule that no longer exists** _(since removed)_');
    expect(md).toContain('- **Rule-Coherence Judge** [Major] — Narrow this rule.');
    expect(md).toContain('  - It contradicts the always rule above it.');
    expect(md).toContain('  - Proposed: Set the rule text to "Avoid jokes about the company."');
    // A prose-only finding has no structured edit, and must not render an empty "Proposed:" line.
    expect(md).not.toContain('  - Proposed: null');
  });
});
