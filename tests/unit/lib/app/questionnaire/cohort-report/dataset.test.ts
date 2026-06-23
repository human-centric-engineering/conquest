/**
 * Unit test: cohort-report dataset builder (F14.1).
 *
 * Mocks the Prisma reads and asserts: overall distributions, demographic segmentation by a `select`
 * profile field and by numeric bucketing, the cohort-subgroup dimension, per-segment k-anonymity
 * suppression (segments below the threshold of 5 withhold detail), and that anonymous mode yields no
 * segmentation at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManySlots = vi.fn();
const findUniqueConfig = vi.fn();
const findManySessions = vi.fn();
const findManyAnswers = vi.fn();
const findManySubgroups = vi.fn();
const findManyDataSlots = vi.fn();
const findManyDataSlotFills = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionSlot: { findMany: (...a: unknown[]) => findManySlots(...a) },
    appQuestionnaireConfig: { findUnique: (...a: unknown[]) => findUniqueConfig(...a) },
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
    appAnswerSlot: { findMany: (...a: unknown[]) => findManyAnswers(...a) },
    appCohortSubgroup: { findMany: (...a: unknown[]) => findManySubgroups(...a) },
    appDataSlot: { findMany: (...a: unknown[]) => findManyDataSlots(...a) },
    appDataSlotFill: { findMany: (...a: unknown[]) => findManyDataSlotFills(...a) },
  },
}));

import { buildCohortDataset } from '@/lib/app/questionnaire/cohort-report/dataset';
import { SUBGROUP_DIMENSION_KEY } from '@/lib/app/questionnaire/cohort-report/types';

/** One free_text slot — detail math is trivial so the tests focus on segmentation + suppression. */
const SLOT = {
  id: 'q1',
  key: 'k1',
  prompt: 'P1',
  type: 'free_text',
  typeConfig: null,
  required: false,
  ordinal: 0,
  section: { title: 'S', ordinal: 0 },
  tags: [],
};

interface SessionSeed {
  id: string;
  status?: string;
  subgroupId?: string | null;
  profile?: Record<string, unknown>;
}

function session(seed: SessionSeed) {
  return {
    id: seed.id,
    status: seed.status ?? 'completed',
    cohortSubgroupId: seed.subgroupId ?? null,
    profileSnapshot: seed.profile ? { values: seed.profile } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManySlots.mockResolvedValue([SLOT]);
  findManyAnswers.mockResolvedValue([]);
  findManySubgroups.mockResolvedValue([]);
  findManyDataSlots.mockResolvedValue([]);
  findManyDataSlotFills.mockResolvedValue([]);
});

const params = { roundId: 'r1', roundName: 'Round One', versionId: 'v1' };

describe('buildCohortDataset', () => {
  it('segments by a select profile field and suppresses small segments', async () => {
    findUniqueConfig.mockResolvedValue({
      anonymousMode: false,
      profileFields: [
        { key: 'team', label: 'Team', type: 'select', required: false, options: ['Eng', 'Sales'] },
      ],
    });
    // 6 Eng (>= threshold 5, surfaced) + 3 Sales (< 5, suppressed) = 9 overall.
    findManySessions.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => session({ id: `e${i}`, profile: { team: 'Eng' } })),
      ...Array.from({ length: 3 }, (_, i) => session({ id: `s${i}`, profile: { team: 'Sales' } })),
    ]);

    const ds = await buildCohortDataset(params);

    expect(ds.totalSessions).toBe(9);
    expect(ds.completedSessions).toBe(9);
    expect(ds.suppressed).toBe(false); // 9 >= 5
    expect(ds.anonymous).toBe(false);
    expect(ds.segmentation).toHaveLength(1);

    const teamDim = ds.segmentation[0];
    expect(teamDim.dimension.key).toBe('team');
    expect(teamDim.dimension.source).toBe('profile');
    expect(teamDim.dimension.kind).toBe('select');

    const eng = teamDim.segments.find((s) => s.value === 'Eng')!;
    const sales = teamDim.segments.find((s) => s.value === 'Sales')!;
    expect(eng.totalSessions).toBe(6);
    expect(eng.suppressed).toBe(false);
    expect(eng.questions[0].detail.kind).toBe('free_text');
    expect(sales.totalSessions).toBe(3);
    expect(sales.suppressed).toBe(true);
    expect(sales.questions[0].detail.kind).toBe('suppressed');
  });

  it('buckets a numeric profile field into ranges', async () => {
    findUniqueConfig.mockResolvedValue({
      anonymousMode: false,
      profileFields: [{ key: 'age', label: 'Age', type: 'number', required: false }],
    });
    findManySessions.mockResolvedValue([
      session({ id: 'a', profile: { age: 22 } }),
      session({ id: 'b', profile: { age: 35 } }),
      session({ id: 'c', profile: { age: 48 } }),
      session({ id: 'd', profile: { age: '61' } }), // stringy numbers coerce
    ]);

    const ds = await buildCohortDataset(params);

    const ageDim = ds.segmentation.find((s) => s.dimension.key === 'age')!;
    expect(ageDim.dimension.kind).toBe('number');
    expect(ageDim.segments.length).toBeGreaterThan(1);
    // Every session landed in some bucket.
    const placed = ageDim.segments.reduce((sum, seg) => sum + seg.totalSessions, 0);
    expect(placed).toBe(4);
  });

  it('adds a subgroup dimension when sessions carry subgroups', async () => {
    findUniqueConfig.mockResolvedValue({ anonymousMode: false, profileFields: [] });
    findManySessions.mockResolvedValue([
      session({ id: 'a', subgroupId: 'g1' }),
      session({ id: 'b', subgroupId: 'g1' }),
      session({ id: 'c', subgroupId: 'g2' }),
    ]);
    findManySubgroups.mockResolvedValue([
      { id: 'g1', name: 'Leadership' },
      { id: 'g2', name: 'Everyone else' },
    ]);

    const ds = await buildCohortDataset(params);

    const subDim = ds.segmentation.find((s) => s.dimension.key === SUBGROUP_DIMENSION_KEY)!;
    expect(subDim.dimension.source).toBe('subgroup');
    const leadership = subDim.segments.find((s) => s.value === 'g1')!;
    expect(leadership.label).toBe('Leadership');
    expect(leadership.totalSessions).toBe(2);
  });

  it('yields no segmentation in anonymous mode', async () => {
    findUniqueConfig.mockResolvedValue({
      anonymousMode: true,
      profileFields: [
        { key: 'team', label: 'Team', type: 'select', required: false, options: ['Eng'] },
      ],
    });
    findManySessions.mockResolvedValue([
      session({ id: 'a', subgroupId: 'g1' }),
      session({ id: 'b', subgroupId: 'g1' }),
    ]);

    const ds = await buildCohortDataset(params);

    expect(ds.anonymous).toBe(true);
    expect(ds.segmentation).toEqual([]);
    expect(ds.overall).toHaveLength(1);
    // Subgroups are never queried in anonymous mode.
    expect(findManySubgroups).not.toHaveBeenCalled();
  });

  it('aggregates data slots overall and per segment (fill rate + confidence)', async () => {
    findUniqueConfig.mockResolvedValue({
      anonymousMode: false,
      profileFields: [
        { key: 'team', label: 'Team', type: 'select', required: false, options: ['Eng', 'Sales'] },
      ],
    });
    findManySessions.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => session({ id: `e${i}`, profile: { team: 'Eng' } })),
      ...Array.from({ length: 6 }, (_, i) => session({ id: `s${i}`, profile: { team: 'Sales' } })),
    ]);
    findManyDataSlots.mockResolvedValue([
      {
        id: 'd1',
        key: 'risk',
        name: 'Risk appetite',
        theme: 'Strategy',
        description: 'how much risk',
      },
    ]);
    // 8 of 12 filled (4 Eng + 1 Sales = 5), with confidences.
    findManyDataSlotFills.mockResolvedValue([
      ...Array.from({ length: 4 }, (_, i) => ({
        sessionId: `e${i}`,
        dataSlotId: 'd1',
        confidence: 0.8,
        provenanceLabel: 'direct',
      })),
      { sessionId: 's0', dataSlotId: 'd1', confidence: 0.6, provenanceLabel: 'inferred' },
    ]);

    const ds = await buildCohortDataset(params);

    expect(ds.dataSlots).toBeDefined();
    const slot = ds.dataSlots!.overall.find((s) => s.key === 'risk')!;
    expect(slot.filled).toBe(5);
    expect(slot.responseRate).toBeCloseTo(5 / 12, 5);
    expect(slot.avgConfidence).toBeCloseTo(0.76, 2); // mean(0.8,0.8,0.8,0.8,0.6)
    expect(slot.provenance.direct).toBe(4);
    expect(slot.provenance.inferred).toBe(1);

    const teamDim = ds.dataSlots!.byDimension.find((d) => d.dimensionKey === 'team')!;
    const riskByTeam = teamDim.slots.find((s) => s.key === 'risk')!;
    expect(riskByTeam.segments.find((s) => s.value === 'Eng')!.filled).toBe(4);
    expect(riskByTeam.segments.find((s) => s.value === 'Sales')!.filled).toBe(1);
  });

  it('omits data slots when the version has none or no fills', async () => {
    findUniqueConfig.mockResolvedValue({ anonymousMode: false, profileFields: [] });
    findManySessions.mockResolvedValue([session({ id: 'a' }), session({ id: 'b' })]);
    findManyDataSlots.mockResolvedValue([
      { id: 'd1', key: 'risk', name: 'Risk', theme: 'S', description: 'x' },
    ]);
    findManyDataSlotFills.mockResolvedValue([]); // no fills

    const ds = await buildCohortDataset(params);
    expect(ds.dataSlots).toBeUndefined();
  });
});
