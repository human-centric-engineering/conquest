/**
 * Unit test: safeguarding summary aggregation (sensitivity awareness).
 *
 * Mocks the session read and asserts flagged/serious counting, preview exclusion (the query
 * filters `isPreview: false`), and k-anonymity suppression on a tiny cohort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManySessions = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
  },
}));

import { getSafeguardingSummary } from '@/lib/app/questionnaire/analytics/safeguarding';
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const scope: AnalyticsScope = {
  versionId: 'v1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
  tagIds: [],
};

/** Build N sessions, `flagged` of them with a level, `serious` of those at 'high'. */
function sessions(total: number, flagged: number, serious: number) {
  return Array.from({ length: total }, (_, i) => ({
    sensitivityLevel: i < serious ? 'high' : i < flagged ? 'low' : null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSafeguardingSummary', () => {
  it('counts flagged + serious sessions above the k-anon threshold', async () => {
    const total = K_ANONYMITY_THRESHOLD + 5;
    findManySessions.mockResolvedValue(sessions(total, 3, 1));
    const result = await getSafeguardingSummary(scope);
    expect(result).toMatchObject({ flagged: 3, serious: 1, suppressed: false });
  });

  it('queries only non-preview sessions in the window', async () => {
    findManySessions.mockResolvedValue(sessions(K_ANONYMITY_THRESHOLD + 1, 1, 0));
    await getSafeguardingSummary(scope);
    expect(findManySessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          versionId: 'v1',
          isPreview: false,
          createdAt: { gte: scope.from, lt: scope.to },
        }),
      })
    );
  });

  it('suppresses counts when the cohort is non-empty but below the k-anon threshold', async () => {
    findManySessions.mockResolvedValue(sessions(K_ANONYMITY_THRESHOLD - 1, 2, 1));
    const result = await getSafeguardingSummary(scope);
    expect(result).toMatchObject({ flagged: 0, serious: 0, suppressed: true });
  });

  it('reports zero (not suppressed) for an empty cohort', async () => {
    findManySessions.mockResolvedValue([]);
    const result = await getSafeguardingSummary(scope);
    expect(result).toMatchObject({ flagged: 0, serious: 0, suppressed: false });
  });
});
