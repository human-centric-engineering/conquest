/**
 * Unit tests for recordAiRun — the persistence seam for AppAiRun (F14.15).
 *
 * Capture is best-effort but never silent: a failed write must return `null`
 * without throwing (the caller's real action must not be lost), and must log
 * at `error` so the gap is visible. These tests assert both halves of that
 * contract, plus the snapshot-capping behaviour the store delegates to
 * `truncateSnapshot` (exercised here through the real function, not a mock,
 * so the `truncated` flag reflects an actual transformation).
 *
 * @see lib/app/questionnaire/ai-run/store.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appAiRun: { create: vi.fn() } },
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { recordAiRun, type RecordAiRunParams } from '@/lib/app/questionnaire/ai-run/store';
import { AI_RUN_SNAPSHOT_MAX_CHARS } from '@/lib/app/questionnaire/ai-run/types';
import { APP_VERSION } from '@/lib/app-version';

type Mock = ReturnType<typeof vi.fn>;

function params(overrides: Partial<RecordAiRunParams> = {}): RecordAiRunParams {
  return {
    subjectKind: 'version',
    subjectId: 'ver-1',
    kind: 'extraction_verify',
    provider: 'openai',
    model: 'gpt-5.4',
    promptSnapshot: 'short prompt',
    outputSnapshot: 'short output',
    ...overrides,
  };
}

/** The `data` object passed to the most recent `prisma.appAiRun.create` call. */
function createdData(): Record<string, unknown> {
  return (prisma.appAiRun.create as unknown as Mock).mock.calls[0][0].data as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordAiRun — success path', () => {
  it('returns the created row id', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-abc' } as never);

    const id = await recordAiRun(params());

    expect(id).toBe('run-abc');
  });

  it('stamps appVersion from APP_VERSION and defaults status to succeeded', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);

    await recordAiRun(params({ status: undefined }));

    const data = createdData();
    expect(data.appVersion).toBe(APP_VERSION);
    expect(data.status).toBe('succeeded');
  });

  it('defaults versionId and triggeredByUserId to null when omitted', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);

    await recordAiRun(params());

    const data = createdData();
    expect(data.versionId).toBeNull();
    expect(data.triggeredByUserId).toBeNull();
  });

  it('maps an absent promptSnapshot/outputSnapshot/detail to undefined (written as SQL NULL)', async () => {
    // lib/app/** may not import Prisma directly (ESLint-enforced storage-agnostic
    // seam), so the store's `toJson` maps an absent value to plain `undefined`
    // rather than `Prisma.DbNull` — Prisma writes an undefined field as SQL NULL
    // on create, which is the same outcome without the forbidden import.
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);

    await recordAiRun(
      params({ promptSnapshot: undefined, outputSnapshot: undefined, detail: undefined })
    );

    const data = createdData();
    expect(data.promptSnapshot).toBeUndefined();
    expect(data.outputSnapshot).toBeUndefined();
    expect(data.detail).toBeUndefined();
    expect(data.truncated).toBe(false);
  });
});

describe('recordAiRun — snapshot capping', () => {
  it('leaves a small snapshot unchanged with truncated=false', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);

    await recordAiRun(params({ promptSnapshot: 'tiny', outputSnapshot: 'also tiny' }));

    const data = createdData();
    expect(data.truncated).toBe(false);
    expect(data.promptSnapshot).toBe('tiny');
    expect(data.outputSnapshot).toBe('also tiny');
  });

  it('caps an oversized prompt snapshot and sets truncated=true', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);
    const hugePrompt = 'x'.repeat(AI_RUN_SNAPSHOT_MAX_CHARS + 500);

    await recordAiRun(params({ promptSnapshot: hugePrompt, outputSnapshot: 'small' }));

    const data = createdData();
    expect(data.truncated).toBe(true);
    expect((data.promptSnapshot as string).length).toBeLessThan(hugePrompt.length);
    expect(data.promptSnapshot as string).toContain('…[truncated]');
    // The output snapshot was not oversized — it must pass through unchanged.
    expect(data.outputSnapshot).toBe('small');
  });

  it('sets truncated=true when only the OUTPUT snapshot is oversized (OR across both)', async () => {
    vi.mocked(prisma.appAiRun.create).mockResolvedValue({ id: 'run-1' } as never);
    const hugeOutput = 'y'.repeat(AI_RUN_SNAPSHOT_MAX_CHARS + 500);

    await recordAiRun(params({ promptSnapshot: 'small', outputSnapshot: hugeOutput }));

    const data = createdData();
    expect(data.truncated).toBe(true);
    expect(data.promptSnapshot).toBe('small');
    expect((data.outputSnapshot as string).length).toBeLessThan(hugeOutput.length);
  });
});

describe('recordAiRun — capture failure never throws', () => {
  it('returns null (not a rejection) when the insert rejects with an Error', async () => {
    vi.mocked(prisma.appAiRun.create).mockRejectedValue(new Error('db down'));

    const id = await recordAiRun(params());

    expect(id).toBeNull();
  });

  it('logs the failure at error level with identifying fields', async () => {
    vi.mocked(prisma.appAiRun.create).mockRejectedValue(new Error('db down'));

    await recordAiRun(
      params({ subjectKind: 'session', subjectId: 'sess-9', kind: 'config_advice' })
    );

    expect(logger.error).toHaveBeenCalledWith(
      'AI run provenance capture failed',
      expect.objectContaining({
        subjectKind: 'session',
        subjectId: 'sess-9',
        kind: 'config_advice',
        error: 'db down',
      })
    );
  });

  it('resolves to null (never throws) even for a non-Error rejection reason', async () => {
    vi.mocked(prisma.appAiRun.create).mockRejectedValue('plain string failure');

    await expect(recordAiRun(params())).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'AI run provenance capture failed',
      expect.objectContaining({ error: 'plain string failure' })
    );
  });
});
