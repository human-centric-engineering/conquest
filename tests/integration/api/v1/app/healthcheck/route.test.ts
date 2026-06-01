import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GET } from '@/app/api/v1/app/healthcheck/route';
import { isFeatureEnabled } from '@/lib/feature-flags';

/**
 * Integration test: GET /api/v1/app/healthcheck.
 *
 * Exercises the full route → flag-gate → feature-flag path with only the
 * DB-backed flag read mocked (mirrors the repo's mocked-Prisma integration
 * style). Verifies the gating template both ways:
 *  - flag off → 404 NOT_FOUND (the app is dark / indistinguishable from missing)
 *  - flag on  → 200 { status: 'ok' }
 */

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(),
}));

const mockedIsFeatureEnabled = vi.mocked(isFeatureEnabled);

describe('GET /api/v1/app/healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 NOT_FOUND when the questionnaire app is disabled', async () => {
    mockedIsFeatureEnabled.mockResolvedValue(false);

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });
    expect(mockedIsFeatureEnabled).toHaveBeenCalledWith('APP_QUESTIONNAIRES_ENABLED');
  });

  it('returns 200 { status: "ok" } when the app is enabled', async () => {
    mockedIsFeatureEnabled.mockResolvedValue(true);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { status: 'ok' } });
  });
});
