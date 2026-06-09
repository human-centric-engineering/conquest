/**
 * Unit test: per-question distribution aggregation (F8.1).
 *
 * Mocks the three Prisma reads and asserts the computed distribution math per type,
 * the response-rate denominator, provenance tallies, and that the session query
 * excludes preview sessions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManySlots = vi.fn();
const findManySessions = vi.fn();
const findManyAnswers = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionSlot: { findMany: (...a: unknown[]) => findManySlots(...a) },
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
    appAnswerSlot: { findMany: (...a: unknown[]) => findManyAnswers(...a) },
  },
}));

import { getQuestionDistributions } from '@/lib/app/questionnaire/analytics/distributions';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const scope: AnalyticsScope = {
  versionId: 'v1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
  tagIds: [],
};

function slot(overrides: Record<string, unknown>) {
  return {
    id: 'q?',
    key: 'k',
    prompt: 'P',
    type: 'free_text',
    typeConfig: null,
    required: false,
    ordinal: 0,
    section: { title: 'Section', ordinal: 0 },
    tags: [],
    ...overrides,
  };
}

/**
 * A cohort of `n` completed sessions (ids `s1..sn`). The detail-math tests need a cohort
 * at or above the F8.3 k-anonymity threshold (5) so per-question detail isn't withheld;
 * answers attach by `questionSlotId`, not session id, so padding never changes the math.
 */
function cohort(n: number): Array<{ id: string; status: 'completed' }> {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, status: 'completed' as const }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getQuestionDistributions', () => {
  it('excludes preview sessions and reports the session denominator', async () => {
    findManySlots.mockResolvedValue([]);
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed' },
      { id: 's2', status: 'active' },
      { id: 's3', status: 'abandoned' },
    ]);
    findManyAnswers.mockResolvedValue([]);

    const result = await getQuestionDistributions(scope);

    expect(result.totalSessions).toBe(3);
    expect(result.completedSessions).toBe(1);
    // The session read must filter out previews and scope to the version + window.
    const where = findManySessions.mock.calls[0][0].where;
    expect(where.isPreview).toBe(false);
    expect(where.versionId).toBe('v1');
    expect(where.createdAt).toEqual({ gte: scope.from, lt: scope.to });
  });

  it('buckets single_choice answers by option and counts unlisted values as other', async () => {
    findManySlots.mockResolvedValue([
      slot({
        id: 'q1',
        type: 'single_choice',
        typeConfig: {
          choices: [
            { value: 'a', label: 'Apple' },
            { value: 'b', label: 'Banana' },
          ],
        },
      }),
    ]);
    // 5 sessions (≥ threshold so detail isn't suppressed); only 4 answered.
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'q1', value: 'a', confidence: 0.8, provenanceLabel: 'direct' },
      { questionSlotId: 'q1', value: 'a', confidence: 0.6, provenanceLabel: 'inferred' },
      { questionSlotId: 'q1', value: 'b', confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'q1', value: 'zzz', confidence: null, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];

    expect(q.answeredCount).toBe(4);
    expect(q.unansweredCount).toBe(1); // 5 sessions, 4 answers
    expect(q.responseRate).toBeCloseTo(0.8, 5);
    // avg of the two scored confidences (0.8, 0.6); nulls ignored.
    expect(q.avgConfidence).toBeCloseTo(0.7, 5);
    expect(q.provenance).toEqual({ direct: 3, inferred: 1, synthesised: 0, refined: 0 });

    expect(q.detail).toMatchObject({ kind: 'choice', otherCount: 1 });
    if (q.detail.kind === 'choice') {
      expect(q.detail.buckets).toEqual([
        { value: 'a', label: 'Apple', count: 2 },
        { value: 'b', label: 'Banana', count: 1 },
      ]);
    }
  });

  it('summarises numeric answers with stats and a histogram', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'q2', type: 'numeric', typeConfig: {} })]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'q2', value: 10, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'q2', value: 20, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'q2', value: 30, confidence: null, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail.kind).toBe('numeric');
    if (q.detail.kind === 'numeric') {
      expect(q.detail.summary).toEqual({ count: 3, min: 10, max: 30, mean: 20, median: 20 });
      const total = q.detail.histogram.reduce((acc, b) => acc + b.count, 0);
      expect(total).toBe(3); // every value lands in a bin
    }
  });

  it('never exposes free-text values, only counts/confidence/provenance', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'q3', type: 'free_text', typeConfig: null })]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      {
        questionSlotId: 'q3',
        value: 'my secret personal answer',
        confidence: 0.9,
        provenanceLabel: 'direct',
      },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail).toEqual({ kind: 'free_text' });
    expect(q.answeredCount).toBe(1);
    // The serialized detail must not carry the prose value anywhere.
    expect(JSON.stringify(q.detail)).not.toContain('secret');
  });

  it('counts multi_choice picks across the answer arrays', async () => {
    findManySlots.mockResolvedValue([
      slot({
        id: 'qm',
        type: 'multi_choice',
        typeConfig: {
          choices: [
            { value: 'a', label: 'Apple' },
            { value: 'b', label: 'Banana' },
            { value: 'c', label: 'Cherry' },
          ],
        },
      }),
    ]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'qm', value: ['a', 'b'], confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qm', value: ['a', 'zzz'], confidence: null, provenanceLabel: 'inferred' },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.answeredCount).toBe(2); // two answer rows (sessions), not picks
    expect(q.detail).toMatchObject({ kind: 'choice', otherCount: 1 });
    if (q.detail.kind === 'choice') {
      expect(q.detail.buckets).toEqual([
        { value: 'a', label: 'Apple', count: 2 },
        { value: 'b', label: 'Banana', count: 1 },
        { value: 'c', label: 'Cherry', count: 0 },
      ]);
    }
  });

  it('buckets likert answers per scale point with bound labels and a mean', async () => {
    findManySlots.mockResolvedValue([
      slot({
        id: 'ql',
        type: 'likert',
        typeConfig: { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' },
      }),
    ]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'ql', value: 1, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'ql', value: 5, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'ql', value: 3, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'ql', value: 9, confidence: null, provenanceLabel: 'direct' }, // out of range → ignored
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail.kind).toBe('likert');
    if (q.detail.kind === 'likert') {
      expect(q.detail.min).toBe(1);
      expect(q.detail.max).toBe(5);
      expect(q.detail.buckets).toHaveLength(5);
      expect(q.detail.buckets[0]).toEqual({ value: '1', label: '1 (Low)', count: 1 });
      expect(q.detail.buckets[4]).toEqual({ value: '5', label: '5 (High)', count: 1 });
      expect(q.detail.mean).toBeCloseTo(3, 5); // (1+5+3)/3, out-of-range dropped
    }
  });

  it('counts boolean answers with custom labels', async () => {
    findManySlots.mockResolvedValue([
      slot({ id: 'qb', type: 'boolean', typeConfig: { trueLabel: 'Yes', falseLabel: 'No' } }),
    ]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'qb', value: true, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qb', value: true, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qb', value: false, confidence: null, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail).toEqual({
      kind: 'boolean',
      trueLabel: 'Yes',
      falseLabel: 'No',
      trueCount: 2,
      falseCount: 1,
    });
  });

  it('buckets date answers by month', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'qd', type: 'date', typeConfig: null })]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'qd', value: '2026-01-15', confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qd', value: '2026-01-20', confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qd', value: '2026-02-02', confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qd', value: 'not-a-date', confidence: null, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail.kind).toBe('date');
    if (q.detail.kind === 'date') {
      expect(q.detail.buckets).toEqual([
        { label: '2026-01', count: 2 },
        { label: '2026-02', count: 1 },
      ]);
    }
  });

  it('degrades gracefully on malformed configs, empty stats, and unknown provenance', async () => {
    findManySlots.mockResolvedValue([
      slot({ id: 'qc', type: 'single_choice', typeConfig: { garbage: true } }), // unreadable choices
      slot({ id: 'ql', type: 'likert', typeConfig: null }), // no bounds → default 1..5, no labels
      slot({ id: 'qb', type: 'boolean', typeConfig: null }), // default True/False labels
      slot({ id: 'qn', type: 'numeric', typeConfig: {} }), // numeric with no numeric answers
    ]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      // choice with no readable config: everything counts as "other"
      { questionSlotId: 'qc', value: 'whatever', confidence: null, provenanceLabel: 'weird' },
      // likert mid value, no labels → plain numeric label
      { questionSlotId: 'ql', value: 3, confidence: null, provenanceLabel: 'synthesised' },
      { questionSlotId: 'qb', value: true, confidence: null, provenanceLabel: 'refined' },
      // numeric answer that isn't a number → dropped → summary null
      { questionSlotId: 'qn', value: 'NaN-ish', confidence: null, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    const [qc, ql, qb, qn] = result.questions;

    // Unknown provenance label falls back to 'direct'.
    expect(qc.provenance.direct).toBe(1);
    expect(qc.detail).toMatchObject({ kind: 'choice', otherCount: 1 });
    if (qc.detail.kind === 'choice') expect(qc.detail.buckets).toEqual([]);

    expect(ql.detail.kind).toBe('likert');
    if (ql.detail.kind === 'likert') {
      expect(ql.detail.min).toBe(1);
      expect(ql.detail.max).toBe(5);
      expect(ql.detail.buckets[2]).toEqual({ value: '3', label: '3', count: 1 }); // no bound label
    }

    expect(qb.detail).toMatchObject({ trueLabel: 'True', falseLabel: 'False', trueCount: 1 });

    expect(qn.detail).toEqual({ kind: 'numeric', summary: null, histogram: [] });
  });

  it('renders a single-bin histogram when all numeric answers are equal', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'qn', type: 'numeric', typeConfig: {} })]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'qn', value: 7, confidence: null, provenanceLabel: 'direct' },
      { questionSlotId: 'qn', value: 7, confidence: null, provenanceLabel: 'direct' },
    ]);
    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail.kind).toBe('numeric'); // guard: a wrong kind must fail, not skip the asserts
    if (q.detail.kind === 'numeric') {
      expect(q.detail.summary).toMatchObject({ min: 7, max: 7, median: 7 });
      expect(q.detail.histogram).toEqual([{ label: '7', min: 7, max: 7, count: 2 }]);
    }
  });

  it('averages the two middle values for an even-count numeric median', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'qn', type: 'numeric', typeConfig: {} })]);
    findManySessions.mockResolvedValue(cohort(5));
    findManyAnswers.mockResolvedValue(
      [10, 20, 30, 40].map((value) => ({
        questionSlotId: 'qn',
        value,
        confidence: null,
        provenanceLabel: 'direct',
      }))
    );
    const result = await getQuestionDistributions(scope);
    const q = result.questions[0];
    expect(q.detail.kind).toBe('numeric');
    if (q.detail.kind === 'numeric') {
      // even count → median = (20 + 30) / 2 = 25, not a single middle element.
      expect(q.detail.summary).toMatchObject({ count: 4, median: 25, mean: 25 });
    }
  });

  it('passes the tag filter into the slot query when tagIds are present', async () => {
    findManySlots.mockResolvedValue([]);
    findManySessions.mockResolvedValue([]);
    await getQuestionDistributions({ ...scope, tagIds: ['t1', 't2'] });
    const where = findManySlots.mock.calls[0][0].where;
    expect(where.tags).toEqual({ some: { tagId: { in: ['t1', 't2'] } } });
  });

  it('skips the answer query entirely when there are no sessions', async () => {
    findManySlots.mockResolvedValue([slot({ id: 'q1', type: 'free_text' })]);
    findManySessions.mockResolvedValue([]);
    const result = await getQuestionDistributions(scope);
    expect(findManyAnswers).not.toHaveBeenCalled();
    expect(result.questions[0].responseRate).toBe(0);
    expect(result.questions[0].answeredCount).toBe(0);
    expect(result.suppressed).toBe(false); // an empty cohort is not "suppressed"
  });

  it('withholds per-question detail below the k-anonymity threshold (F8.3)', async () => {
    findManySlots.mockResolvedValue([
      slot({
        id: 'q1',
        type: 'single_choice',
        typeConfig: { choices: [{ value: 'a', label: 'Apple' }] },
      }),
    ]);
    // 3 sessions (< 5) — a per-question distribution over so few could re-identify.
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed' },
      { id: 's2', status: 'completed' },
      { id: 's3', status: 'completed' },
    ]);
    findManyAnswers.mockResolvedValue([
      { questionSlotId: 'q1', value: 'a', confidence: 0.8, provenanceLabel: 'direct' },
    ]);

    const result = await getQuestionDistributions(scope);
    expect(result.suppressed).toBe(true);
    const q = result.questions[0];
    // Structure is preserved; all response data is withheld.
    expect(q.prompt).toBe('P');
    expect(q.detail).toEqual({ kind: 'suppressed' });
    expect(q.answeredCount).toBe(0);
    expect(q.responseRate).toBe(0);
    expect(q.avgConfidence).toBeNull();
    expect(q.provenance).toEqual({ direct: 0, inferred: 0, synthesised: 0, refined: 0 });
    // No answer value leaks anywhere in the serialized question.
    expect(JSON.stringify(q)).not.toContain('Apple');
  });
});
