/**
 * DEMO-ONLY (F2.5.1) unit test: demo-client read models.
 *
 * Covers listDemoClients + getDemoClientDetail: ISO-date + count projection from
 * the `_count` include, ordering passthrough, and the null (→ 404) path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appDemoClient: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import { listDemoClients, getDemoClientDetail } from '@/app/api/v1/app/demo-clients/_lib/read';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;
const findMany = prisma.appDemoClient.findMany as unknown as Mock;
const findUnique = prisma.appDemoClient.findUnique as unknown as Mock;

const D = new Date('2026-02-03T04:05:06.000Z');

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dc-1',
    slug: 'acme-bank',
    name: 'Acme Bank',
    description: null,
    isActive: true,
    createdAt: D,
    updatedAt: D,
    _count: { questionnaires: 3 },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('listDemoClients', () => {
  it('projects rows to client-safe views (ISO dates, flattened count)', async () => {
    findMany.mockResolvedValue([
      row(),
      row({ id: 'dc-2', slug: 'beta', _count: { questionnaires: 0 } }),
    ]);
    const result = await listDemoClients();
    expect(result).toEqual([
      {
        id: 'dc-1',
        slug: 'acme-bank',
        name: 'Acme Bank',
        description: null,
        isActive: true,
        questionnaireCount: 3,
        createdAt: D.toISOString(),
        updatedAt: D.toISOString(),
      },
      expect.objectContaining({ id: 'dc-2', questionnaireCount: 0 }),
    ]);
  });

  it('orders newest-first', async () => {
    findMany.mockResolvedValue([]);
    await listDemoClients();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
  });
});

describe('getDemoClientDetail', () => {
  it('returns null when the client is unknown', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getDemoClientDetail('missing')).toBeNull();
  });

  it('maps the row to a view', async () => {
    findUnique.mockResolvedValue(row({ description: 'Q1 pitch', isActive: false }));
    const view = await getDemoClientDetail('dc-1');
    expect(view).toMatchObject({
      id: 'dc-1',
      description: 'Q1 pitch',
      isActive: false,
      questionnaireCount: 3,
    });
  });
});
