/**
 * Tests: Scheduled Maintenance Cron Endpoint
 *
 * GET /api/v1/cron/maintenance
 *
 * The serverless-facing cron entry. Unlike the admin tick (202 + fire-and-forget), this checks a
 * CRON_SECRET bearer directly and runs the maintenance tick in AWAITED mode so the background
 * chain (queued respondent reports, eval runs, retries, …) completes before the function is frozen.
 *
 * Coverage:
 * - 503 when CRON_SECRET is not configured (fails closed)
 * - 401 when the bearer is missing or wrong
 * - 200 + schedules result when the bearer is correct
 * - the background chain is AWAITED (response does not resolve until the chain settles)
 *
 * @see app/api/v1/cron/maintenance/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-secret' },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Real run-tick body runs; its individual task modules are mocked so we can drive timing.
vi.mock('@/lib/orchestration/scheduling', () => ({
  processDueSchedules: vi.fn(),
  processPendingExecutions: vi.fn(),
  processOrphanedExecutions: vi.fn(),
}));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({ processPendingRetries: vi.fn() }));
vi.mock('@/lib/orchestration/hooks/registry', () => ({ processPendingHookRetries: vi.fn() }));
vi.mock('@/lib/orchestration/engine/execution-reaper', () => ({ reapZombieExecutions: vi.fn() }));
vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  backfillMissingEmbeddings: vi.fn(),
}));
vi.mock('@/lib/orchestration/retention', () => ({ enforceRetentionPolicies: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/run-worker', () => ({
  processPendingEvaluationRuns: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/worker', () => ({
  processQueuedRespondentReports: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { env } from '@/lib/env';
import {
  processDueSchedules,
  processPendingExecutions,
  processOrphanedExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';
import { __test_setTickRunning } from '@/lib/orchestration/maintenance/run-tick';
import { GET } from '@/app/api/v1/cron/maintenance/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/cron/maintenance', {
    method: 'GET',
    headers,
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SCHEDULE_RESULT = { processed: 1, succeeded: 1, failed: 0, errors: [] };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/cron/maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __test_setTickRunning(false);
    env.CRON_SECRET = 'test-secret';

    vi.mocked(processDueSchedules).mockResolvedValue(SCHEDULE_RESULT);
    vi.mocked(processPendingRetries).mockResolvedValue(0);
    vi.mocked(processPendingHookRetries).mockResolvedValue(0);
    vi.mocked(reapZombieExecutions).mockResolvedValue({
      reaped: 0,
      stalePending: 0,
      abandonedApprovals: 0,
    });
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue({ backfilled: 0, failed: 0 } as never);
    vi.mocked(enforceRetentionPolicies).mockResolvedValue({} as never);
    vi.mocked(processPendingExecutions).mockResolvedValue({ recovered: 0, failed: 0, errors: [] });
    vi.mocked(processOrphanedExecutions).mockResolvedValue({
      recovered: 0,
      exhausted: 0,
      errors: [],
    });
    vi.mocked(processPendingEvaluationRuns).mockResolvedValue({
      claimed: 0,
      completed: 0,
      released: 0,
      failed: 0,
      cancelled: 0,
    });
    vi.mocked(processQueuedRespondentReports).mockResolvedValue({
      claimed: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  afterEach(() => {
    __test_setTickRunning(false);
  });

  it('returns 503 and runs nothing when CRON_SECRET is not configured', async () => {
    env.CRON_SECRET = undefined;

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }));

    expect(response.status).toBe(503);
    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer secret is wrong', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));

    expect(response.status).toBe(401);
    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  it('returns 200 with the schedules result when the bearer is correct', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    const body = await parseJson<{
      success: boolean;
      data: { skipped: boolean; schedules: unknown; durationMs: number };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(false);
    expect(body.data.schedules).toEqual(SCHEDULE_RESULT);
  });

  it('AWAITS the background chain — the response does not resolve until the chain settles', async () => {
    // Hold the report worker pending; because the cron awaits the chain, the GET promise must not
    // resolve until we release it. (The admin tick would have returned 202 immediately here.)
    const deferred = createDeferred<{ claimed: number; succeeded: number; failed: number }>();
    vi.mocked(processQueuedRespondentReports).mockReturnValue(deferred.promise);

    let settled = false;
    const responsePromise = GET(makeRequest({ authorization: 'Bearer test-secret' })).then((r) => {
      settled = true;
      return r;
    });

    // Let microtasks drain — the response must still be pending because the worker hasn't resolved.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    // Release the worker; now the awaited chain completes and the response resolves.
    deferred.resolve({ claimed: 1, succeeded: 1, failed: 0 });
    const response = await responsePromise;

    expect(settled).toBe(true);
    expect(response.status).toBe(200);
    expect(processQueuedRespondentReports).toHaveBeenCalledTimes(1);
  });
});
