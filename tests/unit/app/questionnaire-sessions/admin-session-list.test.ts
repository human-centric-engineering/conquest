/**
 * Unit test: alpha session-ref browser read model (`listAdminSessionRefs`).
 *
 * Prisma is mocked; the real `formatSessionRef` / `normalizeSessionRef` / `narrowToEnum` run. Pins the
 * query shape (base `publicRef not null` filter, status filter, normalised ref substring search,
 * newest-first + pagination), the row mapping, and the defensive skip of malformed rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  listAdminSessionRefs,
  adminSessionListQuerySchema,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

type Mock = ReturnType<typeof vi.fn>;
const findMany = mocks.prisma.appQuestionnaireSession.findMany as Mock;
const count = mocks.prisma.appQuestionnaireSession.count as Mock;

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    publicRef: '7F3K9M2P',
    status: 'completed',
    isPreview: false,
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    versionId: 'v-1',
    version: {
      versionNumber: 3,
      questionnaireId: 'q-1',
      questionnaire: { title: 'Onboarding' },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([row()]);
  count.mockResolvedValue(1);
});

describe('adminSessionListQuerySchema', () => {
  it('defaults page/limit and passes through q/status', () => {
    expect(adminSessionListQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
    expect(
      adminSessionListQuerySchema.parse({ page: '2', limit: '10', q: ' 7F3K ', status: 'active' })
    ).toEqual({
      page: 2,
      limit: 10,
      q: '7F3K',
      status: 'active',
    });
  });

  it('rejects an unknown status', () => {
    expect(adminSessionListQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('listAdminSessionRefs', () => {
  it('filters to sessions with a ref, newest first, and maps rows', async () => {
    const { items, total } = await listAdminSessionRefs({ page: 1, limit: 25 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicRef: { not: null } },
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
    });
  });

  it('paginates via skip/take', async () => {
    await listAdminSessionRefs({ page: 3, limit: 10 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('adds a status filter when supplied', async () => {
    await listAdminSessionRefs({ page: 1, limit: 25, status: 'active' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicRef: { not: null }, status: 'active' } })
    );
    expect(count).toHaveBeenCalledWith({ where: { publicRef: { not: null }, status: 'active' } });
  });

  it('searches by normalised ref substring (folds look-alikes, strips dashes)', async () => {
    await listAdminSessionRefs({ page: 1, limit: 25, q: 'o1-lo' });
    // normalizeSessionRef('o1-lo') → strip dash, O→0, I/L→1 ⇒ '0110'
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicRef: { contains: '0110', mode: 'insensitive' } },
      })
    );
  });

  it('defensively skips rows missing a ref or version', async () => {
    findMany.mockResolvedValue([
      row(),
      row({ id: 'sess-2', publicRef: null }),
      row({ id: 'sess-3', version: null }),
    ]);
    const { items } = await listAdminSessionRefs({ page: 1, limit: 25 });
    expect(items.map((i) => i.sessionId)).toEqual(['sess-1']);
  });

  it('narrows an unknown status to active', async () => {
    findMany.mockResolvedValue([row({ status: 'weird' })]);
    const { items } = await listAdminSessionRefs({ page: 1, limit: 25 });
    expect(items[0].status).toBe('active');
  });
});
