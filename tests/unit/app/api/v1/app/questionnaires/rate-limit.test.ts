/**
 * Unit test for the ingestion sub-cap limiter (F1.1 / PR4, T1.4.4).
 *
 * The route test mocks this module, so it needs its own coverage. We assert the
 * configured cap (10/min) actually throttles — the limiter admits 10 calls for a
 * token then rejects the 11th — proving the wiring, not just the constants.
 */

import { describe, it, expect } from 'vitest';

import {
  ingestLimiter,
  INGEST_RATE_LIMIT_MAX,
  INGEST_RATE_LIMIT_INTERVAL_MS,
} from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

describe('ingestLimiter', () => {
  it('exposes the documented 10/min cap', () => {
    expect(INGEST_RATE_LIMIT_MAX).toBe(10);
    expect(INGEST_RATE_LIMIT_INTERVAL_MS).toBe(60_000);
  });

  it('admits up to the cap for a token, then rejects', () => {
    const token = `admin-${Math.random()}`; // unique per run so other tests don't drain it
    for (let i = 0; i < INGEST_RATE_LIMIT_MAX; i++) {
      expect(ingestLimiter.check(token).success).toBe(true);
    }
    expect(ingestLimiter.check(token).success).toBe(false);
  });

  it('tracks limits independently per token (per-admin keying)', () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    for (let i = 0; i < INGEST_RATE_LIMIT_MAX; i++) ingestLimiter.check(a);
    expect(ingestLimiter.check(a).success).toBe(false); // a is exhausted
    expect(ingestLimiter.check(b).success).toBe(true); // b is independent
  });
});
