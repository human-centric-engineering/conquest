/**
 * Unit test: alpha session-ref browser read model (`listAdminSessionRefs`) + shared where-builder.
 *
 * Prisma is mocked; the real `formatSessionRef` / `normalizeSessionRef` / `narrowToEnum` run. Pins the
 * query shape (base `publicRef not null` filter, status/preview/date/client/round/cohort filters,
 * normalised ref substring search, sort, pagination), the enriched row mapping (client + cohort/round),
 * and the defensive skip of malformed rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findMany: vi.fn(), count: vi.fn() },
    appQuestionSlot: { groupBy: vi.fn() },
    appQuestionnaireRound: { findMany: vi.fn() },
    appCohortMember: { findMany: vi.fn() },
    appCohort: { findMany: vi.fn() },
    appQuestionnaireTurn: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  listAdminSessionRefs,
  buildAdminSessionWhere,
  adminSessionListQuerySchema,
  type AdminSessionListQuery,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

type Mock = ReturnType<typeof vi.fn>;
const findMany = mocks.prisma.appQuestionnaireSession.findMany as Mock;
const count = mocks.prisma.appQuestionnaireSession.count as Mock;
const slotGroupBy = mocks.prisma.appQuestionSlot.groupBy as Mock;
const roundFindMany = mocks.prisma.appQuestionnaireRound.findMany as Mock;
const memberFindMany = mocks.prisma.appCohortMember.findMany as Mock;
const cohortFindMany = mocks.prisma.appCohort.findMany as Mock;
const turnFindMany = mocks.prisma.appQuestionnaireTurn.findMany as Mock;

/** Build a fully-defaulted query from a partial (mirrors what the route validation produces). */
const query = (over: Partial<Record<string, unknown>> = {}): AdminSessionListQuery =>
  adminSessionListQuerySchema.parse(over);

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    publicRef: '7F3K9M2P',
    status: 'completed',
    isPreview: false,
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    versionId: 'v-1',
    roundId: null,
    cohortMemberId: null,
    version: {
      versionNumber: 3,
      questionnaireId: 'q-1',
      questionnaire: { title: 'Onboarding', demoClient: { id: 'dc-1', name: 'Acme' } },
    },
    _count: { turns: 4, answers: 6 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([row()]);
  count.mockResolvedValue(1);
  slotGroupBy.mockResolvedValue([{ versionId: 'v-1', _count: { _all: 10 } }]);
  roundFindMany.mockResolvedValue([]);
  memberFindMany.mockResolvedValue([]);
  cohortFindMany.mockResolvedValue([]);
  turnFindMany.mockResolvedValue([]);
});

describe('adminSessionListQuerySchema', () => {
  it('defaults page/limit/sort/order and passes through q/status', () => {
    expect(adminSessionListQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 25,
      sort: 'createdAt',
      order: 'desc',
    });
    expect(
      adminSessionListQuerySchema.parse({ page: '2', limit: '10', q: ' 7F3K ', status: 'active' })
    ).toEqual({
      page: 2,
      limit: 10,
      q: '7F3K',
      status: 'active',
      sort: 'createdAt',
      order: 'desc',
    });
  });

  it('rejects an unknown status and a malformed date', () => {
    expect(adminSessionListQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(adminSessionListQuerySchema.safeParse({ from: '07/16/2026' }).success).toBe(false);
  });
});

describe('buildAdminSessionWhere', () => {
  it('hides preview sessions by default (bare ref filter + isPreview false)', async () => {
    expect(await buildAdminSessionWhere(query())).toEqual({
      publicRef: { not: null },
      isPreview: false,
    });
  });

  it('honours the preview toggle: false/omitted → real only, true → preview only, all → both', async () => {
    expect((await buildAdminSessionWhere(query({ isPreview: 'false' }))).isPreview).toBe(false);
    expect((await buildAdminSessionWhere(query({ isPreview: 'true' }))).isPreview).toBe(true);
    // `all` opts into both — no isPreview clause at all.
    expect((await buildAdminSessionWhere(query({ isPreview: 'all' }))).isPreview).toBeUndefined();
  });

  it('adds status + date-window clauses', async () => {
    const where = await buildAdminSessionWhere(
      query({ status: 'active', from: '2026-07-01', to: '2026-07-31' })
    );
    expect(where.status).toBe('active');
    expect(where.createdAt).toEqual({
      gte: new Date('2026-07-01T00:00:00.000Z'),
      lte: new Date('2026-07-31T23:59:59.999Z'),
    });
  });

  it('filters by client via the version→questionnaire relation (with an unassigned sentinel)', async () => {
    expect((await buildAdminSessionWhere(query({ demoClientId: 'dc-1' }))).version).toEqual({
      questionnaire: { demoClientId: 'dc-1' },
    });
    expect((await buildAdminSessionWhere(query({ demoClientId: 'unassigned' }))).version).toEqual({
      questionnaire: { demoClientId: null },
    });
  });

  it('filters by round id, and the none sentinel selects open-ended sessions', async () => {
    expect((await buildAdminSessionWhere(query({ roundId: 'r-1' }))).roundId).toBe('r-1');
    expect((await buildAdminSessionWhere(query({ roundId: 'none' }))).roundId).toBeNull();
  });

  it('resolves a cohort to its rounds + members and matches either pointer', async () => {
    roundFindMany.mockResolvedValue([{ id: 'r-1' }, { id: 'r-2' }]);
    memberFindMany.mockResolvedValue([{ id: 'm-1' }]);
    const where = await buildAdminSessionWhere(query({ cohortId: 'c-1' }));
    expect(where.OR).toEqual([
      { roundId: { in: ['r-1', 'r-2'] } },
      { cohortMemberId: { in: ['m-1'] } },
    ]);
  });

  it('an empty cohort resolves to an impossible clause (never matches all)', async () => {
    const where = await buildAdminSessionWhere(query({ cohortId: 'c-empty' }));
    expect(where.OR).toEqual([{ id: '__no_match__' }]);
  });
});

describe('listAdminSessionRefs', () => {
  it('lists newest first and maps enriched rows (client + cohort/round)', async () => {
    const { items, total } = await listAdminSessionRefs(query());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicRef: { not: null }, isPreview: false },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      })
    );
    expect(total).toBe(1);
    expect(items[0]).toEqual({
      sessionId: 'sess-1',
      ref: '7F3K9M2P',
      refFormatted: '7F3K-9M2P',
      status: 'completed',
      isPreview: false,
      createdAt: '2026-07-16T10:00:00.000Z',
      questionnaireId: 'q-1',
      questionnaireTitle: 'Onboarding',
      versionId: 'v-1',
      versionNumber: 3,
      clientId: 'dc-1',
      clientName: 'Acme',
      roundId: null,
      roundName: null,
      cohortId: null,
      cohortName: null,
      turns: 4,
      answeredCount: 6,
      totalQuestions: 10,
      percentComplete: 60,
      // No turns mocked → timing is unknown.
      durationMs: null,
      activeMs: null,
      sittings: null,
    });
  });

  it('derives duration + sittings from turn timestamps (a >30m gap starts a new sitting)', async () => {
    const t = (min: number) => ({
      sessionId: 'sess-1',
      createdAt: new Date(2026, 6, 16, 10, min, 0),
    });
    // Two turns 5m apart, then a 60m gap, then two more 5m apart → 2 sittings, ~10m active, 70m elapsed.
    turnFindMany.mockResolvedValue([t(0), t(5), t(65), t(70)]);
    const { items } = await listAdminSessionRefs(query());
    expect(items[0].durationMs).toBe(70 * 60 * 1000);
    expect(items[0].activeMs).toBe(10 * 60 * 1000);
    expect(items[0].sittings).toBe(2);
  });

  it('resolves the round name + cohort for a round-linked session', async () => {
    findMany.mockResolvedValue([row({ roundId: 'r-1' })]);
    roundFindMany.mockResolvedValue([{ id: 'r-1', name: 'Q3 Leadership', cohortId: 'c-1' }]);
    cohortFindMany.mockResolvedValue([{ id: 'c-1', name: 'Leadership Team' }]);

    const { items } = await listAdminSessionRefs(query());
    expect(items[0]).toMatchObject({
      roundId: 'r-1',
      roundName: 'Q3 Leadership',
      cohortId: 'c-1',
      cohortName: 'Leadership Team',
    });
  });

  it('sorts by turn count when asked', async () => {
    await listAdminSessionRefs(query({ sort: 'turns', order: 'asc' }));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { turns: { _count: 'asc' } } })
    );
  });

  it('reports 100% completion when a version has no slots', async () => {
    slotGroupBy.mockResolvedValue([]); // version 'v-1' has no question slots
    const { items } = await listAdminSessionRefs(query());
    expect(items[0].totalQuestions).toBe(0);
    expect(items[0].percentComplete).toBe(100);
  });

  it('paginates via skip/take', async () => {
    await listAdminSessionRefs(query({ page: 3, limit: 10 }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('searches by normalised ref substring (folds look-alikes, strips dashes)', async () => {
    await listAdminSessionRefs(query({ q: 'o1-lo' }));
    // normalizeSessionRef('o1-lo') → strip dash, O→0, I/L→1 ⇒ '0110'
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicRef: { contains: '0110', mode: 'insensitive' }, isPreview: false },
      })
    );
  });

  it('defensively skips rows missing a ref or version', async () => {
    findMany.mockResolvedValue([
      row(),
      row({ id: 'sess-2', publicRef: null }),
      row({ id: 'sess-3', version: null }),
    ]);
    const { items } = await listAdminSessionRefs(query());
    expect(items.map((i) => i.sessionId)).toEqual(['sess-1']);
  });

  it('narrows an unknown status to active', async () => {
    findMany.mockResolvedValue([row({ status: 'weird' })]);
    const { items } = await listAdminSessionRefs(query());
    expect(items[0].status).toBe('active');
  });
});
