/**
 * Unit test: buildCohortDataset — version-scope behaviour (F14.x).
 *
 * Asserts that a versionScope dataset queries sessions WITHOUT a roundId filter (spans all rounds +
 * open-ended sessions), and that dataset.roundId is null and dataset.roundName equals the scope label.
 * The existing dataset.test.ts covers round-scope; this file covers the version-scope delta only.
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
import { versionScope } from '@/lib/app/questionnaire/cohort-report/scope';

const VERSION_LABEL = 'Version-wide (all rounds)';
const scope = versionScope('v1', VERSION_LABEL);

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

beforeEach(() => {
  vi.clearAllMocks();
  findManySlots.mockResolvedValue([SLOT]);
  findManyAnswers.mockResolvedValue([]);
  findManySubgroups.mockResolvedValue([]);
  findManyDataSlots.mockResolvedValue([]);
  findManyDataSlotFills.mockResolvedValue([]);
  findUniqueConfig.mockResolvedValue({ anonymousMode: false, profileFields: [] });
});

describe('buildCohortDataset — versionScope', () => {
  it('queries sessions without a roundId filter so it spans all rounds and open-ended sessions', async () => {
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
      { id: 's2', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
    ]);

    await buildCohortDataset(scope);

    // The session query must NOT include a roundId constraint — version-wide means every session.
    const [[sessionQueryArg]] = findManySessions.mock.calls;
    expect(sessionQueryArg.where).not.toHaveProperty('roundId');
    // But versionId and isPreview:false are still required for correctness.
    expect(sessionQueryArg.where.versionId).toBe('v1');
    expect(sessionQueryArg.where.isPreview).toBe(false);
  });

  it('returns dataset.roundId = null and dataset.roundName = scope label', async () => {
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
    ]);

    const ds = await buildCohortDataset(scope);

    // roundId = null distinguishes version-wide from round-scoped in the UI and PDF header.
    expect(ds.roundId).toBeNull();
    expect(ds.roundName).toBe(VERSION_LABEL);
    expect(ds.versionId).toBe('v1');
  });

  it('counts all sessions regardless of which round they belong to', async () => {
    // Simulate 3 sessions from different rounds (no roundId on the session row — the version-wide
    // query doesn't filter them out).
    findManySessions.mockResolvedValue([
      { id: 'a', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
      { id: 'b', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
      { id: 'c', status: 'completed', cohortSubgroupId: null, profileSnapshot: null },
    ]);

    const ds = await buildCohortDataset(scope);

    expect(ds.totalSessions).toBe(3);
  });
});
