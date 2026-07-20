/**
 * Unit tests: experience-wide synthesis persistence and read view (P15.8).
 *
 * Three things carry real weight here.
 *
 * 1. **No revision chain.** Unlike `AppCohortReport`, a synthesis is one row per experience,
 *    replaced on regeneration — because it reads a MOVING target (its own step-report inputs are
 *    themselves regenerated). `completeExperienceSynthesis` sets `costUsd` directly rather than
 *    incrementing it, which is a real, easy-to-get-backwards divergence from the cohort-report
 *    persistence pattern this module deliberately does NOT mirror.
 * 2. **A failed regeneration must not destroy a previously working synthesis.** `failExperienceSynthesis`
 *    writes only `status` and `error` — never touches `content` — so a bad regeneration preserves
 *    whatever the admin already had.
 * 3. **The read view degrades gracefully.** No row → an explicit empty view, never null or a throw.
 *    A malformed persisted `content` blob is run through the real validator, not trusted as-is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appExperienceSynthesis: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  beginExperienceSynthesis,
  completeExperienceSynthesis,
  failExperienceSynthesis,
  getExperienceSynthesisView,
} from '@/lib/app/questionnaire/experiences/synthesis/persist';
import type { ExperienceSynthesisContent } from '@/lib/app/questionnaire/experiences/synthesis/types';

type Mock = ReturnType<typeof vi.fn>;
const findUnique = mocks.prisma.appExperienceSynthesis.findUnique as Mock;
const upsert = mocks.prisma.appExperienceSynthesis.upsert as Mock;
const update = mocks.prisma.appExperienceSynthesis.update as Mock;

const CONTENT: ExperienceSynthesisContent = {
  narrative: 'Everything agreed across the journey.',
  findings: [{ statement: 'A', detail: null, sourceStepKeys: ['intake'] }],
  divergences: [],
  coverage: [{ stepKey: 'intake', stepTitle: 'Intake', included: true, reason: 'included' }],
  caveats: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getExperienceSynthesisView', () => {
  it('returns an explicit empty view — never null — when no row exists yet', async () => {
    findUnique.mockResolvedValue(null);
    const view = await getExperienceSynthesisView('exp-1');
    expect(view).toEqual({
      exists: false,
      status: 'queued',
      content: null,
      coveredSteps: 0,
      eligibleSteps: 0,
      costUsd: null,
      error: null,
      generatedAt: null,
    });
  });

  it('maps a ready row through, converting generatedAt to an ISO string', async () => {
    const generatedAt = new Date('2026-07-01T12:00:00.000Z');
    findUnique.mockResolvedValue({
      status: 'ready',
      content: CONTENT,
      coveredSteps: 3,
      eligibleSteps: 4,
      costUsd: 0.42,
      error: null,
      generatedAt,
    });
    const view = await getExperienceSynthesisView('exp-1');
    expect(view.exists).toBe(true);
    expect(view.generatedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(view.coveredSteps).toBe(3);
    expect(view.eligibleSteps).toBe(4);
    expect(view.costUsd).toBe(0.42);
  });

  it('returns null generatedAt when the row has never generated (never coerces to a fake date)', async () => {
    findUnique.mockResolvedValue({
      status: 'queued',
      content: null,
      coveredSteps: 0,
      eligibleSteps: 0,
      costUsd: null,
      error: null,
      generatedAt: null,
    });
    const view = await getExperienceSynthesisView('exp-1');
    expect(view.generatedAt).toBeNull();
  });

  it('falls back an unrecognised persisted status to queued rather than leaking a raw DB value', async () => {
    findUnique.mockResolvedValue({
      status: 'some-legacy-value',
      content: null,
      coveredSteps: 0,
      eligibleSteps: 0,
      costUsd: null,
      error: null,
      generatedAt: null,
    });
    const view = await getExperienceSynthesisView('exp-1');
    expect(view.status).toBe('queued');
  });

  it('keeps a previously generated content through validation, alongside a live error', async () => {
    // A failed regeneration leaves `content` populated from the last success — the read view must
    // surface both: the reader is better served by the old synthesis plus an error than by nothing.
    findUnique.mockResolvedValue({
      status: 'failed',
      content: CONTENT,
      coveredSteps: 3,
      eligibleSteps: 4,
      costUsd: 0.42,
      error: 'LLM timed out',
      generatedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const view = await getExperienceSynthesisView('exp-1');
    expect(view.status).toBe('failed');
    expect(view.error).toBe('LLM timed out');
    expect(view.content?.narrative).toBe(CONTENT.narrative);
  });

  it('runs a malformed persisted content blob through the real validator instead of trusting it', async () => {
    // Proves this is a real transformation, not a passthrough: a garbage `narrative` (wrong type)
    // and a garbage `findings` (wrong shape) must both come back sanitised.
    findUnique.mockResolvedValue({
      status: 'ready',
      content: { narrative: 12345, findings: 'not-an-array', coverage: null },
      coveredSteps: 0,
      eligibleSteps: 0,
      costUsd: null,
      error: null,
      generatedAt: null,
    });
    const view = await getExperienceSynthesisView('exp-1');
    expect(view.content).toEqual({
      narrative: '',
      findings: [],
      divergences: [],
      coverage: [],
      caveats: [],
    });
  });

  it('queries by experienceId', async () => {
    findUnique.mockResolvedValue(null);
    await getExperienceSynthesisView('exp-42');
    expect(findUnique).toHaveBeenCalledWith({ where: { experienceId: 'exp-42' } });
  });
});

describe('beginExperienceSynthesis', () => {
  it('upserts: creates a processing row with the creator on first run', async () => {
    upsert.mockResolvedValue({ id: 'syn-1' });
    const id = await beginExperienceSynthesis('exp-1', 'user-1');
    expect(id).toBe('syn-1');
    expect(upsert).toHaveBeenCalledWith({
      where: { experienceId: 'exp-1' },
      create: { experienceId: 'exp-1', status: 'processing', createdBy: 'user-1' },
      update: { status: 'processing', error: null },
      select: { id: true },
    });
  });

  it('records a null creator for a system-triggered run (e.g. scheduled regeneration)', async () => {
    upsert.mockResolvedValue({ id: 'syn-1' });
    await beginExperienceSynthesis('exp-1', null);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ createdBy: null }) })
    );
  });

  it('on a regeneration, the update branch clears any previous error without touching createdBy', async () => {
    upsert.mockResolvedValue({ id: 'syn-1' });
    await beginExperienceSynthesis('exp-1', 'user-2');
    const call = upsert.mock.calls[0][0];
    // The update clause is intentionally narrow: status + error only. It must not attempt to
    // reset createdBy (that would misattribute an existing row to whoever re-triggered it) and
    // must not touch content (a still-generating run must not clobber the last-known-good synthesis).
    expect(call.update).toEqual({ status: 'processing', error: null });
    expect(call.update).not.toHaveProperty('createdBy');
    expect(call.update).not.toHaveProperty('content');
  });
});

describe('completeExperienceSynthesis', () => {
  it('writes a ready status with the given content, coverage counts, and cost — set directly, not incremented', async () => {
    update.mockResolvedValue({});
    await completeExperienceSynthesis({
      experienceId: 'exp-1',
      content: CONTENT,
      coveredSteps: 3,
      eligibleSteps: 4,
      costUsd: 0.75,
    });
    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0];
    expect(call.where).toEqual({ experienceId: 'exp-1' });
    expect(call.data.status).toBe('ready');
    expect(call.data.content).toEqual(CONTENT);
    expect(call.data.coveredSteps).toBe(3);
    expect(call.data.eligibleSteps).toBe(4);
    // Direct assignment — no `{ increment: ... }` wrapper. Unlike the cohort-report pipeline's
    // cumulative cost, a synthesis has no revision history to accumulate across: each generation
    // replaces the one row wholesale.
    expect(call.data.costUsd).toBe(0.75);
    expect(call.data.error).toBeNull();
  });

  it('stamps a fresh generatedAt on every completion', async () => {
    update.mockResolvedValue({});
    const before = Date.now();
    await completeExperienceSynthesis({
      experienceId: 'exp-1',
      content: CONTENT,
      coveredSteps: 1,
      eligibleSteps: 1,
      costUsd: 0,
    });
    const call = update.mock.calls[0][0];
    expect(call.data.generatedAt).toBeInstanceOf(Date);
    expect(call.data.generatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('failExperienceSynthesis', () => {
  it('marks the row failed with the error, WITHOUT touching content — preserving any prior synthesis', async () => {
    update.mockResolvedValue({});
    await failExperienceSynthesis('exp-1', 'LLM call failed');
    expect(update).toHaveBeenCalledWith({
      where: { experienceId: 'exp-1' },
      data: { status: 'failed', error: 'LLM call failed' },
    });
    // The failure path must never mention content/coveredSteps/eligibleSteps/costUsd — a retry
    // that fails again should leave the reader with exactly what they had before, plus an error.
    const call = update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('content');
    expect(call.data).not.toHaveProperty('coveredSteps');
  });

  it('truncates an oversized error message to the persisted cap', async () => {
    update.mockResolvedValue({});
    const huge = 'x'.repeat(5_000);
    await failExperienceSynthesis('exp-1', huge);
    const call = update.mock.calls[0][0];
    expect(call.data.error).toHaveLength(1_000);
  });

  it('swallows an update failure (row not yet created) instead of throwing', async () => {
    // beginExperienceSynthesis always creates the row first in the real flow, but a failure
    // reached before that upsert lands (or a race) must not crash the caller's error handling.
    update.mockRejectedValue(new Error('Record to update not found.'));
    await expect(failExperienceSynthesis('exp-1', 'boom')).resolves.toBeUndefined();
  });
});

describe('status transitions', () => {
  it('begin -> complete: processing then ready, same experienceId both times', async () => {
    upsert.mockResolvedValue({ id: 'syn-1' });
    update.mockResolvedValue({});

    await beginExperienceSynthesis('exp-1', 'user-1');
    await completeExperienceSynthesis({
      experienceId: 'exp-1',
      content: CONTENT,
      coveredSteps: 2,
      eligibleSteps: 2,
      costUsd: 0.1,
    });

    expect(upsert.mock.calls[0][0].create.status).toBe('processing');
    expect(update.mock.calls[0][0].data.status).toBe('ready');
    expect(upsert.mock.calls[0][0].where.experienceId).toBe('exp-1');
    expect(update.mock.calls[0][0].where.experienceId).toBe('exp-1');
  });

  it('begin -> fail: processing then failed, content untouched by either call in the fail path', async () => {
    upsert.mockResolvedValue({ id: 'syn-1' });
    update.mockResolvedValue({});

    await beginExperienceSynthesis('exp-1', 'user-1');
    await failExperienceSynthesis('exp-1', 'generation blew up');

    expect(upsert.mock.calls[0][0].create.status).toBe('processing');
    expect(update.mock.calls[0][0].data.status).toBe('failed');
    expect(update.mock.calls[0][0].data.error).toBe('generation blew up');
  });
});
