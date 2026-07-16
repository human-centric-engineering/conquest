import { describe, it, expect } from 'vitest';

import { GET } from '@/app/api/v1/app/healthcheck/route';

/**
 * Integration test: GET /api/v1/app/healthcheck.
 *
 * Liveness probe — unauthenticated by design, always returns 200 { status: 'ok' }.
 */

describe('GET /api/v1/app/healthcheck', () => {
  it('returns 200 { status: "ok" }', async () => {
    const res = GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { status: 'ok' } });
  });
});
