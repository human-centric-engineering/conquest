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
  dataSlotsAssignLimiter,
  DATA_SLOTS_ASSIGN_RATE_LIMIT_MAX,
  DATA_SLOTS_ASSIGN_RATE_LIMIT_INTERVAL_MS,
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

describe('dataSlotsAssignLimiter', () => {
  it('exposes the documented 20/min cap', () => {
    expect(DATA_SLOTS_ASSIGN_RATE_LIMIT_MAX).toBe(20);
    expect(DATA_SLOTS_ASSIGN_RATE_LIMIT_INTERVAL_MS).toBe(60_000);
  });

  it('admits the cap then throttles, keyed per admin', () => {
    const a = `assign-a-${Math.random()}`;
    const b = `assign-b-${Math.random()}`;
    for (let i = 0; i < DATA_SLOTS_ASSIGN_RATE_LIMIT_MAX; i++) {
      expect(dataSlotsAssignLimiter.check(a).success).toBe(true);
    }
    expect(dataSlotsAssignLimiter.check(a).success).toBe(false); // a exhausted
    expect(dataSlotsAssignLimiter.check(b).success).toBe(true); // b independent
  });
});
