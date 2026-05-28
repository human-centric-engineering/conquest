/**
 * Tests: monitoring validation schemas
 *
 * The `healthCheckResponseSchema` is the runtime guard at the
 * `/api/health` fetch boundary in `components/status/use-health-check.ts`.
 * These tests defend the two properties the hook depends on:
 *
 *  1. A well-formed `/api/health` payload (including the new `sunrise`
 *     field added in PR #268) parses successfully.
 *  2. A payload **missing** the `sunrise` field fails the parse — this is
 *     the regression that the bare `as HealthCheckResponse` cast used to
 *     silently allow. The test pins the new contract.
 *
 * @see lib/validations/monitoring.ts
 * @see components/status/use-health-check.ts
 */

import { describe, it, expect } from 'vitest';
import { healthCheckResponseSchema } from '@/lib/validations/monitoring';

const validPayload = {
  status: 'ok' as const,
  version: '0.0.0',
  sunrise: '0.0.0',
  uptime: 1234,
  timestamp: '2026-05-28T10:00:00.000Z',
  services: {
    database: {
      status: 'operational' as const,
      connected: true,
      latency: 5,
    },
  },
};

describe('healthCheckResponseSchema', () => {
  it('accepts a well-formed /api/health success payload (including sunrise field)', () => {
    const result = healthCheckResponseSchema.safeParse(validPayload);

    expect(result.success).toBe(true);
    if (result.success) {
      // Confirm the parse preserves the contract-bearing fields exactly
      // (not just "doesn't throw") — a schema that silently strips fields
      // would also pass `success: true` here.
      expect(result.data.sunrise).toBe('0.0.0');
      expect(result.data.version).toBe('0.0.0');
      expect(result.data.services.database.status).toBe('operational');
    }
  });

  it('rejects a payload missing the sunrise field', () => {
    // Older deployments (or a stripping proxy) might return a payload
    // without `sunrise`. The old `as HealthCheckResponse` cast accepted
    // it silently; the schema must not.
    const { sunrise: _, ...payloadWithoutSunrise } = validPayload;
    void _;

    const result = healthCheckResponseSchema.safeParse(payloadWithoutSunrise);

    expect(result.success).toBe(false);
    if (!result.success) {
      // The Zod error should name the missing field — operators reading
      // the runtime error want to know what's wrong, not just that
      // "something" failed.
      expect(JSON.stringify(result.error.issues)).toContain('sunrise');
    }
  });

  it('rejects a payload with a wrong-type field', () => {
    const malformed = { ...validPayload, uptime: 'not a number' };

    const result = healthCheckResponseSchema.safeParse(malformed);

    expect(result.success).toBe(false);
  });

  it('accepts the optional memory and error fields when present', () => {
    const withOptionals = {
      ...validPayload,
      memory: { heapUsed: 100, heapTotal: 200, rss: 300, percentage: 50 },
      error: 'something',
    };

    const result = healthCheckResponseSchema.safeParse(withOptionals);

    expect(result.success).toBe(true);
  });
});
