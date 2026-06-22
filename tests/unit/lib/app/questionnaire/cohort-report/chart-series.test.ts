/**
 * Unit test: cohort-report chart series builder (F14.2).
 *
 * Asserts `buildChartData` maps a {@link ChartSpec} onto the uniform {@link ChartData} for each kind:
 * question distributions (choice/likert/boolean buckets), by-segment means + response/completion
 * rates, segment sizes — and that suppressed questions/segments and stale references degrade to
 * suppressed/empty rather than misleading zeros.
 */

import { describe, it, expect } from 'vitest';

import { buildChartData } from '@/lib/app/questionnaire/cohort-report/chart-series';
import type { ChartSpec } from '@/lib/app/questionnaire/cohort-report/chart-types';
import type { CohortDataset, CohortSegment } from '@/lib/app/questionnaire/cohort-report/types';
import type {
  DistributionDetail,
  QuestionDistribution,
} from '@/lib/app/questionnaire/analytics/views';

function q(
  questionId: string,
  detail: DistributionDetail,
  overrides: Partial<QuestionDistribution> = {}
): QuestionDistribution {
  return {
    questionId,
    key: questionId,
    prompt: 'P',
    type: 'single_choice',
    sectionTitle: 'S',
    required: false,
    tags: [],
    answeredCount: 0,
    unansweredCount: 0,
    responseRate: 0,
    avgConfidence: null,
    provenance: { direct: 0, inferred: 0, synthesised: 0, refined: 0 },
    detail,
    ...overrides,
  };
}

function segment(value: string, overrides: Partial<CohortSegment> = {}): CohortSegment {
  return {
    value,
    label: value,
    totalSessions: 6,
    completedSessions: 6,
    suppressed: false,
    questions: [],
    ...overrides,
  };
}

function dataset(overrides: Partial<CohortDataset> = {}): CohortDataset {
  return {
    roundId: 'r1',
    roundName: 'R',
    versionId: 'v1',
    totalSessions: 12,
    completedSessions: 10,
    kThreshold: 5,
    suppressed: false,
    anonymous: false,
    overall: [],
    segmentation: [],
    ...overrides,
  };
}

describe('buildChartData', () => {
  it('plots a choice question distribution as one bar per option', () => {
    const ds = dataset({
      overall: [
        q('q1', {
          kind: 'choice',
          otherCount: 0,
          buckets: [
            { value: 'a', label: 'Agree', count: 7 },
            { value: 'd', label: 'Disagree', count: 3 },
          ],
        }),
      ],
    });
    const spec: ChartSpec = {
      id: 'c1',
      title: 'Q1',
      kind: 'question_distribution',
      questionId: 'q1',
    };
    const out = buildChartData(spec, ds);
    expect(out.suppressed).toBe(false);
    expect(out.empty).toBe(false);
    expect(out.isPercent).toBe(false);
    expect(out.data).toEqual([
      { category: 'Agree', values: { count: 7 } },
      { category: 'Disagree', values: { count: 3 } },
    ]);
  });

  it('marks a suppressed question distribution suppressed', () => {
    const ds = dataset({ overall: [q('q1', { kind: 'suppressed' })] });
    const out = buildChartData(
      { id: 'c', title: 'Q', kind: 'question_distribution', questionId: 'q1' },
      ds
    );
    expect(out.suppressed).toBe(true);
    expect(out.data).toEqual([]);
  });

  it('returns empty for a free_text question and for an unknown question id', () => {
    const ds = dataset({ overall: [q('q1', { kind: 'free_text' })] });
    expect(
      buildChartData({ id: 'c', title: 'Q', kind: 'question_distribution', questionId: 'q1' }, ds)
        .empty
    ).toBe(true);
    expect(
      buildChartData({ id: 'c', title: 'Q', kind: 'question_distribution', questionId: 'nope' }, ds)
        .empty
    ).toBe(true);
  });

  it('plots likert means per segment and omits suppressed segments', () => {
    const likert = (mean: number | null): DistributionDetail => ({
      kind: 'likert',
      min: 1,
      max: 5,
      buckets: [],
      mean,
    });
    const ds = dataset({
      segmentation: [
        {
          dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
          segments: [
            segment('Eng', { questions: [q('q1', likert(4.2))] }),
            segment('Sales', { suppressed: true, questions: [q('q1', { kind: 'suppressed' })] }),
          ],
        },
      ],
    });
    const out = buildChartData(
      {
        id: 'c',
        title: 'Mean by team',
        kind: 'question_mean_by_segment',
        questionId: 'q1',
        dimensionKey: 'team',
      },
      ds
    );
    // Sales is suppressed → omitted; only Eng's mean is plotted.
    expect(out.data).toEqual([{ category: 'Eng', values: { count: 4.2 } }]);
    expect(out.valueLabel).toBe('Mean');
  });

  it('plots completion rate per segment as a percent axis', () => {
    const ds = dataset({
      segmentation: [
        {
          dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
          segments: [
            segment('Eng', { totalSessions: 10, completedSessions: 8 }),
            segment('Sales', { totalSessions: 5, completedSessions: 5 }),
          ],
        },
      ],
    });
    const out = buildChartData(
      { id: 'c', title: 'Completion by team', kind: 'completion_by_segment', dimensionKey: 'team' },
      ds
    );
    expect(out.isPercent).toBe(true);
    expect(out.data).toEqual([
      { category: 'Eng', values: { count: 0.8 } },
      { category: 'Sales', values: { count: 1 } },
    ]);
  });

  it('plots segment sizes', () => {
    const ds = dataset({
      segmentation: [
        {
          dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
          segments: [segment('Eng', { totalSessions: 10 }), segment('Sales', { totalSessions: 5 })],
        },
      ],
    });
    const out = buildChartData(
      { id: 'c', title: 'Sizes', kind: 'segment_sizes', dimensionKey: 'team' },
      ds
    );
    expect(out.data).toEqual([
      { category: 'Eng', values: { count: 10 } },
      { category: 'Sales', values: { count: 5 } },
    ]);
  });

  it('returns empty for an unknown dimension', () => {
    const out = buildChartData(
      { id: 'c', title: 'X', kind: 'segment_sizes', dimensionKey: 'ghost' },
      dataset()
    );
    expect(out.empty).toBe(true);
  });
});
