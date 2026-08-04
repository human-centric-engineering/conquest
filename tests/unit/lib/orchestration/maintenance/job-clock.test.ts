/**
 * Tests for `lib/orchestration/maintenance/job-clock.ts` (#442).
 *
 * The clock is what decides whether the maintenance tick touches the database
 * at all, so the two things worth pinning are the interval arithmetic (an
 * off-by-one at the boundary either hammers the DB or stalls a sweep) and the
 * in-flight latch (a hung task must not be started a second time).
 */

import { describe, it, expect } from 'vitest';

import { createJobClock } from '@/lib/orchestration/maintenance/job-clock';

const MINUTE = 60 * 1000;

describe('createJobClock', () => {
  it('reports a never-run job as due', () => {
    const clock = createJobClock();

    expect(clock.isDue('retention', MINUTE, 1_000_000)).toBe(true);
  });

  it('holds a job back until its interval has elapsed', () => {
    const clock = createJobClock();
    const t0 = 1_000_000;

    clock.markStarted('retention', t0);
    clock.markSettled('retention');

    expect(clock.isDue('retention', 5 * MINUTE, t0 + 4 * MINUTE)).toBe(false);
    // Exactly at the boundary counts as due — the tick that lands on the
    // interval must not be pushed out to the next one.
    expect(clock.isDue('retention', 5 * MINUTE, t0 + 5 * MINUTE)).toBe(true);
  });

  it('measures start-to-start, not end-to-start', () => {
    // The stamp is the value passed to markStarted, so a job that takes four
    // minutes on a five-minute interval is due one minute after it finishes,
    // not five. Otherwise a slow job silently drifts its own cadence.
    const clock = createJobClock();
    const startedAt = 1_000_000;

    clock.markStarted('slowSweep', startedAt);
    clock.markSettled('slowSweep'); // finished 4 minutes later, wall-clock

    expect(clock.isDue('slowSweep', 5 * MINUTE, startedAt + 5 * MINUTE)).toBe(true);
  });

  it('treats a zero interval as every tick', () => {
    const clock = createJobClock();

    clock.markStarted('webhookRetries', 1_000_000);
    clock.markSettled('webhookRetries');

    // Same millisecond — a responsive task must not be throttled at all.
    expect(clock.isDue('webhookRetries', 0, 1_000_000)).toBe(true);
  });

  it('never reports an in-flight job as due, however overdue it is', () => {
    const clock = createJobClock();
    const t0 = 1_000_000;

    clock.markStarted('zombieReaper', t0); // still running — no markSettled

    expect(clock.isDue('zombieReaper', 5 * MINUTE, t0 + 60 * MINUTE)).toBe(false);
  });

  it('makes a job due again once it settles', () => {
    const clock = createJobClock();
    const t0 = 1_000_000;

    clock.markStarted('zombieReaper', t0);
    clock.markSettled('zombieReaper');

    expect(clock.isDue('zombieReaper', 5 * MINUTE, t0 + 5 * MINUTE)).toBe(true);
  });

  it('tracks each name independently', () => {
    const clock = createJobClock();
    const t0 = 1_000_000;

    clock.markStarted('retention', t0);
    clock.markSettled('retention');

    expect(clock.isDue('retention', 5 * MINUTE, t0)).toBe(false);
    expect(clock.isDue('embeddingBackfill', 5 * MINUTE, t0)).toBe(true);
  });

  it('keeps two clocks from sharing state', () => {
    // Registries must not share a clock or a fork job named `retention` would
    // throttle Sunrise's sweep.
    const platform = createJobClock();
    const app = createJobClock();
    const t0 = 1_000_000;

    platform.markStarted('retention', t0);
    platform.markSettled('retention');

    expect(app.isDue('retention', 5 * MINUTE, t0)).toBe(true);
  });

  it('reset clears both the stamps and the latch', () => {
    const clock = createJobClock();
    const t0 = 1_000_000;

    clock.markStarted('retention', t0); // deliberately left in flight
    clock.reset();

    expect(clock.isDue('retention', 5 * MINUTE, t0)).toBe(true);
  });
});
