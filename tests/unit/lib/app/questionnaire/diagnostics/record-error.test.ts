/**
 * Unit test: diagnostics error capture (`recordQuestionnaireError`).
 *
 * Prisma + logger are mocked. Pins the capture seam's contract: it normalizes arbitrary thrown
 * values, backfills version/invitation from the session, drops (never persists) an unattributable
 * row, and — the critical property, since it runs on already-failing paths — NEVER throws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireError: { create: vi.fn() },
    appQuestionnaireSession: { findUnique: vi.fn() },
  },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));

import { recordQuestionnaireError } from '@/lib/app/questionnaire/diagnostics/record-error';

type Mock = ReturnType<typeof vi.fn>;
const create = mocks.prisma.appQuestionnaireError.create as Mock;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;

function dataOf(): Record<string, unknown> {
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'err-1' });
});

describe('recordQuestionnaireError', () => {
  it('normalizes an Error into code, message, and stack', async () => {
    const err = new TypeError('boom');
    await recordQuestionnaireError({ versionId: 'v-1', scope: 'pipeline', error: err });
    const data = dataOf();
    expect(data).toMatchObject({
      versionId: 'v-1',
      scope: 'pipeline',
      severity: 'error',
      code: 'TypeError',
      message: 'boom',
    });
    expect(typeof data.stack).toBe('string');
  });

  it('accepts a string error (message only, no code/stack)', async () => {
    await recordQuestionnaireError({
      versionId: 'v-1',
      scope: 'cost_cap',
      severity: 'warning',
      code: 'COST_CAP_REACHED',
      error: 'Budget exhausted',
    });
    const data = dataOf();
    expect(data).toMatchObject({
      severity: 'warning',
      code: 'COST_CAP_REACHED',
      message: 'Budget exhausted',
      stack: null,
    });
  });

  it('backfills versionId and invitationId from the session when only sessionId is given', async () => {
    findSession.mockResolvedValue({ versionId: 'v-9', invitationId: 'inv-7' });
    await recordQuestionnaireError({ sessionId: 'sess-1', scope: 'turn', error: new Error('x') });
    expect(findSession).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      select: { versionId: true, invitationId: true },
    });
    expect(dataOf()).toMatchObject({
      versionId: 'v-9',
      sessionId: 'sess-1',
      invitationId: 'inv-7',
    });
  });

  it('does not overwrite an explicit versionId with the session lookup', async () => {
    findSession.mockResolvedValue({ versionId: 'v-from-session', invitationId: 'inv-2' });
    await recordQuestionnaireError({
      versionId: 'v-explicit',
      sessionId: 'sess-1',
      scope: 'turn',
      error: new Error('x'),
    });
    expect(dataOf().versionId).toBe('v-explicit');
  });

  it('drops the row (no create) and warns when no version can be resolved', async () => {
    findSession.mockResolvedValue(null);
    await recordQuestionnaireError({
      sessionId: 'ghost',
      scope: 'session_create',
      error: 'bad token',
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('omits metadata when none is supplied, and includes it when present', async () => {
    await recordQuestionnaireError({ versionId: 'v-1', scope: 'turn', error: new Error('a') });
    expect(dataOf().metadata).toBeUndefined();

    create.mockClear();
    await recordQuestionnaireError({
      versionId: 'v-1',
      scope: 'invitation_send',
      error: 'send failed',
      metadata: { email: 'x@y.z' },
    });
    expect(dataOf().metadata).toEqual({ email: 'x@y.z' });
  });

  it('never throws when the create write itself fails', async () => {
    create.mockRejectedValue(new Error('db down'));
    await expect(
      recordQuestionnaireError({ versionId: 'v-1', scope: 'turn', error: new Error('orig') })
    ).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('truncates a pathologically long message', async () => {
    const huge = 'x'.repeat(10_000);
    await recordQuestionnaireError({ versionId: 'v-1', scope: 'turn', error: huge });
    const msg = dataOf().message as string;
    expect(msg.length).toBeLessThanOrEqual(4_001); // 4000 + ellipsis
    expect(msg.endsWith('…')).toBe(true);
  });
});
