/**
 * Unit test: cohort-report content validation + prompt substrate (F14.3).
 *
 * Asserts `validateCohortReportContent` coerces/bounds the agent output, drops malformed charts and
 * dangling chart references, and `buildCohortDatasetDigest` renders a k-anonymity-safe digest
 * (suppressed questions/segments surface as "hidden", never their values).
 */

import { describe, it, expect } from 'vitest';

import {
  validateCohortReportContent,
  isUsableCohortReportContent,
  buildCohortDatasetDigest,
  buildChartCatalogText,
} from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';
import type { QuestionDistribution } from '@/lib/app/questionnaire/analytics/views';

function q(id: string, detail: QuestionDistribution['detail']): QuestionDistribution {
  return {
    questionId: id,
    key: id,
    prompt: `Prompt ${id}`,
    type: 'single_choice',
    sectionTitle: 'S',
    required: false,
    tags: [],
    answeredCount: 0,
    unansweredCount: 0,
    responseRate: 0.5,
    avgConfidence: null,
    provenance: { direct: 0, inferred: 0, synthesised: 0, refined: 0 },
    detail,
  };
}

describe('validateCohortReportContent', () => {
  it('keeps valid charts and prunes section references to dropped charts', () => {
    const content = validateCohortReportContent({
      summary: '  Overview  ',
      sections: [
        { heading: 'Findings', body: 'Body', chartIds: ['c1', 'ghost'] },
        { heading: '', body: '' }, // empty section dropped
      ],
      charts: [
        { id: 'c1', title: 'Chart 1', kind: 'segment_sizes', dimensionKey: 'team' },
        { id: 'bad', title: 'Bad', kind: 'not_a_kind' }, // invalid kind dropped
        { id: 'c1', title: 'Dup', kind: 'segment_sizes' }, // duplicate id dropped
      ],
      recommendations: ['Do X', '', 42],
      actions: ['Step 1'],
    });

    expect(content.summary).toBe('Overview');
    expect(content.charts.map((c) => c.id)).toEqual(['c1']);
    expect(content.sections).toHaveLength(1);
    // 'ghost' pruned (no such chart); 'c1' kept.
    expect(content.sections[0].chartIds).toEqual(['c1']);
    expect(content.recommendations).toEqual(['Do X']);
    expect(content.actions).toEqual(['Step 1']);
  });

  it('returns an empty-but-valid shell for garbage input', () => {
    const content = validateCohortReportContent('nonsense');
    expect(content.summary).toBe('');
    expect(content.sections).toEqual([]);
    expect(content.charts).toEqual([]);
    expect(isUsableCohortReportContent(content)).toBe(false);
  });

  it('treats a summary-only or section-only result as usable', () => {
    expect(isUsableCohortReportContent(validateCohortReportContent({ summary: 'Hi' }))).toBe(true);
    expect(
      isUsableCohortReportContent(
        validateCohortReportContent({ sections: [{ heading: 'H', body: 'B' }] })
      )
    ).toBe(true);
  });
});

const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1 Pulse',
  versionId: 'v1',
  totalSessions: 12,
  completedSessions: 10,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [
    q('q1', {
      kind: 'choice',
      otherCount: 0,
      buckets: [
        { value: 'a', label: 'Agree', count: 8 },
        { value: 'd', label: 'Disagree', count: 2 },
      ],
    }),
    q('q2', { kind: 'suppressed' }),
  ],
  segmentation: [
    {
      dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
      segments: [
        {
          value: 'Eng',
          label: 'Eng',
          totalSessions: 7,
          completedSessions: 6,
          suppressed: false,
          questions: [],
        },
        {
          value: 'Sales',
          label: 'Sales',
          totalSessions: 3,
          completedSessions: 3,
          suppressed: true,
          questions: [],
        },
      ],
    },
  ],
};

describe('buildCohortDatasetDigest', () => {
  it('summarises overall results and segments without leaking suppressed values', () => {
    const digest = buildCohortDatasetDigest(dataset);
    expect(digest).toContain('Q1 Pulse');
    expect(digest).toContain('Agree=8');
    // Suppressed question + segment surface as hidden, never their figures.
    expect(digest).toContain('hidden');
    expect(digest).toContain('Sales');
    expect(digest).toContain('too few');
  });

  it('flags anonymous mode and omits segmentation', () => {
    const digest = buildCohortDatasetDigest({ ...dataset, anonymous: true, segmentation: [] });
    expect(digest).toContain('Anonymous mode');
    expect(digest).not.toContain('BY TEAM');
  });

  it('includes the data-slot section when present', () => {
    const withSlots = buildCohortDatasetDigest({
      ...dataset,
      dataSlots: {
        overall: [
          {
            key: 'risk',
            name: 'Risk appetite',
            theme: 'Strategy',
            filled: 9,
            responseRate: 0.75,
            avgConfidence: 0.82,
            provenance: { direct: 9, inferred: 0, synthesised: 0, refined: 0 },
            suppressed: false,
          },
        ],
        byDimension: [],
      },
    });
    expect(withSlots).toContain('DATA SLOTS');
    expect(withSlots).toContain('Risk appetite');
    expect(withSlots).toContain('75%');
  });
});

describe('buildCohortDatasetDigest — narrowed instruments (P17)', () => {
  /** A dataset whose scale was fully assessed for six people and partial for two more. */
  function withScoring(over: {
    respondents: number;
    mean: number | null;
    partiallyAssessed: number;
    suppressed?: boolean;
  }) {
    return buildCohortDatasetDigest({
      ...dataset,
      scoring: {
        scales: [
          {
            scaleKey: 'wellbeing',
            scaleName: 'Wellbeing',
            respondents: over.respondents,
            mean: over.mean,
            bandCounts: over.mean === null ? [] : [{ label: 'Steady', count: over.respondents }],
            suppressed: over.suppressed ?? false,
            partiallyAssessed: over.partiallyAssessed,
          },
        ],
        byDimension: [],
      },
    });
  }

  it('tells the writer how many respondents the mean leaves out', () => {
    // A writer given only a mean will describe it as the cohort's. For a narrowed instrument it is
    // the mean of the people who were asked the whole scale, and the difference is the report's.
    const digest = withScoring({ respondents: 6, mean: 3.0, partiallyAssessed: 2 });

    expect(digest).toContain('mean 3.00 (n=6)');
    expect(digest).toContain('excludes 2 respondent(s) asked only part of this scale');
  });

  it('says nothing about exclusions when nobody was narrowed', () => {
    const digest = withScoring({ respondents: 6, mean: 3.0, partiallyAssessed: 0 });
    expect(digest).toContain('mean 3.00 (n=6)');
    expect(digest).not.toContain('excludes');
  });

  it('separates "not reportable" from "too few respondents"', () => {
    // Different facts, and a writer must not paraphrase the first as small-sample caution: nobody
    // was measured on the scale as authored, so there is no number waiting behind a bigger cohort.
    const digest = withScoring({ respondents: 0, mean: null, partiallyAssessed: 6 });
    const scaleLine = digest.split('\n').find((l) => l.includes('Wellbeing')) ?? '';

    expect(scaleLine).toContain('not reportable');
    expect(scaleLine).toContain('every respondent was asked only part of this scale (6)');
    // The digest's other "too few" lines are about suppressed QUESTIONS; this scale must not
    // borrow that wording, because a bigger cohort would not produce the missing number.
    expect(scaleLine).not.toContain('too few');
  });
});

describe('buildCohortDatasetDigest — every detail kind (summariseQuestion)', () => {
  it('renders a distinct line for matrix, numeric, boolean, date, and free_text detail', () => {
    // A fresh dataset built from the shared fixture — the shared `dataset` const is never mutated,
    // only spread into a new object with a replacement `overall` list.
    const withEveryKind: CohortDataset = {
      ...dataset,
      overall: [
        q('qm', {
          kind: 'matrix',
          min: 1,
          max: 5,
          rows: [
            { key: 'r1', label: 'Comfort', buckets: [], mean: 3.5 },
            { key: 'r2', label: 'Speed', buckets: [], mean: 2.25 },
          ],
        }),
        q('qn', {
          kind: 'numeric',
          summary: { count: 9, min: 2, max: 20, mean: 11.444, median: 11 },
          histogram: [],
        }),
        q('qb', {
          kind: 'boolean',
          trueLabel: 'Yes',
          falseLabel: 'No',
          trueCount: 7,
          falseCount: 3,
        }),
        q('qd', {
          kind: 'date',
          buckets: [
            { label: '2026-01', count: 4 },
            { label: '2026-02', count: 6 },
          ],
        }),
        q('qf', { kind: 'free_text' }),
      ],
    };

    const digest = buildCohortDatasetDigest(withEveryKind);

    // matrix: one row-mean per row, each to 2dp — 3.5.toFixed(2)='3.50', 2.25.toFixed(2)='2.25'.
    expect(digest).toContain('mean by row (1–5) Comfort=3.50, Speed=2.25');
    // numeric: mean to 1dp — 11.444.toFixed(1)='11.4' (rounds down since the 2nd decimal is 4).
    expect(digest).toContain('mean 11.4, range 2–20');
    // boolean: raw true/false counts, unrounded.
    expect(digest).toContain('Yes=7, No=3');
    // date: raw bucket counts in order.
    expect(digest).toContain('2026-01=4, 2026-02=6');
    // free_text: never aggregated — a fixed, literal line regardless of the underlying answers.
    expect(digest).toContain('[free text — not aggregated]');
  });
});

describe('buildChartCatalogText', () => {
  it('lists the exact question ids and dimension keys the agent may reference', () => {
    const catalog = buildChartCatalogText(dataset);
    expect(catalog).toContain('q1 —');
    expect(catalog).toContain('team — Team (profile)');
  });
});
