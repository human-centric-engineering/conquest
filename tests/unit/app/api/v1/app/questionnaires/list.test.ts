/**
 * Unit test: listQuestionnaires read model (P2 / F2.1a).
 *
 * Proves the enrichment is done in a FIXED number of queries regardless of page
 * size (no per-row N+1) and that latest-version counts map onto the right rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findMany: vi.fn(), count: vi.fn() },
    appQuestionnaireSection: { groupBy: vi.fn() },
    appQuestionSlot: { groupBy: vi.fn() },
    appDataSlot: { groupBy: vi.fn() },
  },
}));

import { listQuestionnaires } from '@/app/api/v1/app/questionnaires/_lib/list';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;

const findMany = prisma.appQuestionnaire.findMany as unknown as Mock;
const count = prisma.appQuestionnaire.count as unknown as Mock;
const sectionGroupBy = prisma.appQuestionnaireSection.groupBy as unknown as Mock;
const slotGroupBy = prisma.appQuestionSlot.groupBy as unknown as Mock;
const dataSlotGroupBy = prisma.appDataSlot.groupBy as unknown as Mock;

const D1 = new Date('2026-01-01T00:00:00.000Z');
const D2 = new Date('2026-01-02T00:00:00.000Z');

function row(id: string, latestVersionId: string | null, archivedAt: Date | null = null) {
  return {
    id,
    title: `Q ${id}`,
    status: 'draft',
    archivedAt,
    createdAt: D1,
    updatedAt: D2,
    _count: { versions: latestVersionId ? 2 : 0 },
    versions: latestVersionId ? [{ id: latestVersionId, versionNumber: 3, status: 'draft' }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listQuestionnaires', () => {
  it('enriches a multi-row page in a fixed query budget (no per-row N+1)', async () => {
    findMany.mockResolvedValue([row('qn-1', 'ver-1'), row('qn-2', 'ver-2')]);
    count.mockResolvedValue(2);
    sectionGroupBy.mockResolvedValue([
      { versionId: 'ver-1', _count: { _all: 2 } },
      { versionId: 'ver-2', _count: { _all: 4 } },
    ]);
    slotGroupBy.mockResolvedValue([
      { versionId: 'ver-1', _count: { _all: 7 } },
      { versionId: 'ver-2', _count: { _all: 9 } },
    ]);
    dataSlotGroupBy.mockResolvedValue([
      { versionId: 'ver-1', _count: { _all: 3 } },
      { versionId: 'ver-2', _count: { _all: 5 } },
    ]);

    const { items, total } = await listQuestionnaires({
      page: 1,
      limit: 25,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    // Exactly one of each — the two groupBy sweeps replace N per-row count queries.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(sectionGroupBy).toHaveBeenCalledTimes(1);
    expect(slotGroupBy).toHaveBeenCalledTimes(1);

    expect(total).toBe(2);
    expect(items[0]).toMatchObject({
      id: 'qn-1',
      latestVersion: { id: 'ver-1', versionNumber: 3, status: 'draft' },
      sectionCount: 2,
      questionCount: 7,
      versionCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(items[1]).toMatchObject({ id: 'qn-2', sectionCount: 4, questionCount: 9 });
  });

  it('skips the count sweeps when no row has a version, and zeroes the counts', async () => {
    findMany.mockResolvedValue([row('qn-1', null)]);
    count.mockResolvedValue(1);

    const { items } = await listQuestionnaires({
      page: 1,
      limit: 25,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    expect(sectionGroupBy).not.toHaveBeenCalled();
    expect(slotGroupBy).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({
      latestVersion: null,
      sectionCount: 0,
      questionCount: 0,
    });
  });

  it('applies status + title filters and pagination to the query', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await listQuestionnaires({
      page: 3,
      limit: 10,
      q: 'intake',
      status: 'launched',
      sortBy: 'title',
      sortOrder: 'asc',
    });

    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      status: 'launched',
      title: { contains: 'intake', mode: 'insensitive' },
    });
    expect(arg.skip).toBe(20); // (3 - 1) * 10
    expect(arg.take).toBe(10);
    expect(arg.orderBy).toEqual({ title: 'asc' });
  });

  it('excludes archived rows by default (archivedAt: null)', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await listQuestionnaires({ page: 1, limit: 25, sortBy: 'updatedAt', sortOrder: 'desc' });

    // Both the page query and the count share the same gate.
    expect(findMany.mock.calls[0][0].where.archivedAt).toBeNull();
    expect(count.mock.calls[0][0].where.archivedAt).toBeNull();
  });

  it('shows only archived rows when archived=true (archivedAt: { not: null })', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await listQuestionnaires({
      page: 1,
      limit: 25,
      archived: 'true',
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    expect(findMany.mock.calls[0][0].where.archivedAt).toEqual({ not: null });
    expect(count.mock.calls[0][0].where.archivedAt).toEqual({ not: null });
  });

  it('serialises a present archivedAt to an ISO string on the row', async () => {
    findMany.mockResolvedValue([row('qn-1', null, D2)]);
    count.mockResolvedValue(1);

    const { items } = await listQuestionnaires({
      page: 1,
      limit: 25,
      archived: 'true',
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    expect(items[0].archivedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});
