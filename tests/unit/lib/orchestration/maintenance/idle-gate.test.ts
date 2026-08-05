/**
 * Tests for `lib/orchestration/maintenance/idle-gate.ts` (#442).
 *
 * The gate is a licence to do *no* database work, so the tests that matter are
 * the ones that pin when it must refuse: work already on the horizon, a horizon
 * in the past, a cap of zero. A gate that over-skips loses work; a gate that
 * under-skips only costs queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  DEFAULT_MAX_SKIP_MS,
  armIdleGate,
  idleGateResumesAt,
  noteMaintenanceWork,
  shouldSkipIdleTick,
  __resetIdleGateForTests,
} from '@/lib/orchestration/maintenance/idle-gate';

const MINUTE = 60 * 1000;
const T0 = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  __resetIdleGateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetIdleGateForTests();
});

describe('shouldSkipIdleTick', () => {
  it('is false on a cold start, so a fresh instance always sweeps', () => {
    // The gate is per-process memory; a restart must not inherit a skip.
    expect(shouldSkipIdleTick(T0)).toBe(false);
  });

  it('is true inside an armed window and false once it elapses', () => {
    armIdleGate({ now: T0, nextWorkAtMs: null });

    expect(shouldSkipIdleTick(T0 + MINUTE)).toBe(true);
    expect(shouldSkipIdleTick(T0 + DEFAULT_MAX_SKIP_MS - 1)).toBe(true);
    // The tick that lands exactly on the horizon must sweep, not skip.
    expect(shouldSkipIdleTick(T0 + DEFAULT_MAX_SKIP_MS)).toBe(false);
  });
});

describe('armIdleGate', () => {
  it('skips for the cap when nothing is queued', () => {
    const until = armIdleGate({ now: T0, nextWorkAtMs: null });

    expect(until).toBe(T0 + DEFAULT_MAX_SKIP_MS);
  });

  it('never skips past known work', () => {
    // A workflow schedule due in 40s keeps firing on time — this is the
    // assertion that makes the gate safe to enable by default.
    const scheduleDueAt = T0 + 40_000;

    const until = armIdleGate({ now: T0, nextWorkAtMs: scheduleDueAt });

    expect(until).toBe(scheduleDueAt);
    expect(shouldSkipIdleTick(T0 + 39_000)).toBe(true);
    expect(shouldSkipIdleTick(scheduleDueAt)).toBe(false);
  });

  it('caps a distant horizon so the DB is re-verified regularly', () => {
    // A nightly job 8 hours out must not license an 8-hour skip: another
    // instance, or a hand-edited row, would go unseen until then.
    const until = armIdleGate({ now: T0, nextWorkAtMs: T0 + 8 * 60 * MINUTE });

    expect(until).toBe(T0 + DEFAULT_MAX_SKIP_MS);
  });

  it('refuses to arm when the horizon is already in the past', () => {
    const until = armIdleGate({ now: T0, nextWorkAtMs: T0 - MINUTE });

    expect(until).toBe(0);
    expect(shouldSkipIdleTick(T0)).toBe(false);
  });

  it('re-arming replaces the previous window rather than extending it', () => {
    armIdleGate({ now: T0, nextWorkAtMs: null });
    const until = armIdleGate({ now: T0 + MINUTE, nextWorkAtMs: T0 + 2 * MINUTE });

    expect(until).toBe(T0 + 2 * MINUTE);
    expect(shouldSkipIdleTick(T0 + 3 * MINUTE)).toBe(false);
  });
});

describe('noteMaintenanceWork', () => {
  it('disarms an armed gate so the next tick sweeps', () => {
    armIdleGate({ now: T0, nextWorkAtMs: null });

    noteMaintenanceWork('evaluation-run-queued');

    expect(shouldSkipIdleTick(T0 + MINUTE)).toBe(false);
    expect(idleGateResumesAt()).toBe(0);
  });

  it('is a no-op when the gate is already disarmed', () => {
    // Called from hot request paths (every failed webhook delivery), so the
    // common case must not log.
    noteMaintenanceWork('webhook-delivery-retry');

    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe('MAINTENANCE_IDLE_MAX_SKIP_MS', () => {
  it('disables the gate entirely when set to 0', () => {
    // The documented off-switch: every tick does a full sweep, as before #442.
    vi.stubEnv('MAINTENANCE_IDLE_MAX_SKIP_MS', '0');

    const until = armIdleGate({ now: T0, nextWorkAtMs: null });

    expect(until).toBe(0);
    expect(shouldSkipIdleTick(T0)).toBe(false);
  });

  it('honours a custom cap', () => {
    vi.stubEnv('MAINTENANCE_IDLE_MAX_SKIP_MS', String(5 * MINUTE));

    expect(armIdleGate({ now: T0, nextWorkAtMs: null })).toBe(T0 + 5 * MINUTE);
  });

  it('is read per call, so a change takes effect without a restart of the module', () => {
    armIdleGate({ now: T0, nextWorkAtMs: null });
    vi.stubEnv('MAINTENANCE_IDLE_MAX_SKIP_MS', String(2 * MINUTE));

    expect(armIdleGate({ now: T0, nextWorkAtMs: null })).toBe(T0 + 2 * MINUTE);
  });

  it('falls back to the default and warns on a value that is not a non-negative integer', () => {
    // A typo must not silently mean "skip forever" or "never skip".
    vi.stubEnv('MAINTENANCE_IDLE_MAX_SKIP_MS', 'thirty-minutes');

    expect(armIdleGate({ now: T0, nextWorkAtMs: null })).toBe(T0 + DEFAULT_MAX_SKIP_MS);
    expect(logger.warn).toHaveBeenCalledWith(
      'MAINTENANCE_IDLE_MAX_SKIP_MS is not a non-negative integer; using the default',
      expect.objectContaining({ value: 'thirty-minutes' })
    );
  });

  it('falls back to the default on a negative value', () => {
    vi.stubEnv('MAINTENANCE_IDLE_MAX_SKIP_MS', '-1');

    expect(armIdleGate({ now: T0, nextWorkAtMs: null })).toBe(T0 + DEFAULT_MAX_SKIP_MS);
  });
});
