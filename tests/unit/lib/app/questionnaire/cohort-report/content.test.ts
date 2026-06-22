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
});

describe('buildChartCatalogText', () => {
  it('lists the exact question ids and dimension keys the agent may reference', () => {
    const catalog = buildChartCatalogText(dataset);
    expect(catalog).toContain('q1 —');
    expect(catalog).toContain('team — Team (profile)');
  });
});
