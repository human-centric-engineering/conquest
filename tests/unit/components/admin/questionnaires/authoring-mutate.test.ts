/**
 * authoringMutate — the shared authoring fetch helper. Beyond returning `{data, meta}`, it owns the
 * client half of the fork-confirmation protocol: it tags every request `x-fork-confirm: prompt`, and
 * when the server answers the fork-confirmation 409 it asks the mounted provider (via the bridge) to
 * confirm, then either retries with `x-fork-confirm: confirmed` or throws `ForkCancelledError`.
 *
 * `global.fetch` and the bridge's `requestForkConfirm` are mocked; `parseApiResponse` is real, so the
 * fake responses must be well-formed API envelopes.
 *
 * @see components/admin/questionnaires/authoring-mutate.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridge = vi.hoisted(() => ({
  requestForkConfirm: vi.fn(),
  // Pass-through by default (valid details); individual tests override to null for the skew case.
  parseForkConfirmDetails: vi.fn((raw: unknown) => raw),
}));
vi.mock('@/components/admin/questionnaires/fork-confirm-bridge', () => bridge);

import {
  authoringMutate,
  AuthoringError,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';

/** A fake fetch Response whose `.json()` yields the given API envelope. */
function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

const FORK_409 = {
  success: false,
  error: {
    code: 'VERSION_FORK_CONFIRMATION_REQUIRED',
    message: 'confirm',
    details: {
      sourceVersionNumber: 2,
      nextVersionNumber: 3,
      versions: [
        { versionNumber: 2, status: 'launched' },
        { versionNumber: 1, status: 'archived' },
      ],
    },
  },
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

describe('authoringMutate', () => {
  it('sends x-fork-confirm: prompt and returns data + meta on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { ok: 1 }, meta: { forked: false } })
    );

    const result = await authoringMutate('PATCH', '/cfg', { a: 1 });

    expect(result).toEqual({ data: { ok: 1 }, meta: { forked: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['x-fork-confirm']).toBe('prompt');
    expect(bridge.requestForkConfirm).not.toHaveBeenCalled();
  });

  it('on the fork 409, confirms then retries with x-fork-confirm: confirmed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FORK_409))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ok: 1 }, meta: { forked: true, versionId: 'v3' } })
      );
    bridge.requestForkConfirm.mockResolvedValue({ confirmed: true, archiveSource: false });

    const result = await authoringMutate('PATCH', '/cfg', { a: 1 });

    // The dialog was fed the server's lineage details.
    expect(bridge.requestForkConfirm).toHaveBeenCalledWith(FORK_409.error.details);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders['x-fork-confirm']).toBe('confirmed');
    // Checkbox unticked → no archive header sent.
    expect(retryHeaders['x-fork-archive-source']).toBeUndefined();
    expect(result.meta?.forked).toBe(true);
  });

  it('sends x-fork-archive-source on the retry when the admin opts to archive the previous version', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FORK_409))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ok: 1 }, meta: { forked: true } })
      );
    bridge.requestForkConfirm.mockResolvedValue({ confirmed: true, archiveSource: true });

    await authoringMutate('PATCH', '/cfg', { a: 1 });

    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders['x-fork-confirm']).toBe('confirmed');
    expect(retryHeaders['x-fork-archive-source']).toBe('true');
  });

  it('throws ForkCancelledError and does NOT retry when the fork is declined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(FORK_409));
    bridge.requestForkConfirm.mockResolvedValue({ confirmed: false, archiveSource: false });

    await expect(authoringMutate('PATCH', '/cfg', {})).rejects.toBeInstanceOf(ForkCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('surfaces the raw error (no prompt) when the 409 details are malformed', async () => {
    // Deploy skew: server sent the fork code but details failed validation.
    fetchMock.mockResolvedValueOnce(jsonResponse(FORK_409));
    bridge.parseForkConfirmDetails.mockReturnValueOnce(null);

    await expect(authoringMutate('PATCH', '/cfg', {})).rejects.toMatchObject({
      name: 'AuthoringError',
      code: 'VERSION_FORK_CONFIRMATION_REQUIRED',
    });
    expect(bridge.requestForkConfirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws AuthoringError (with code) on a non-fork failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } })
    );

    await expect(authoringMutate('POST', '/x', {})).rejects.toMatchObject({
      name: 'AuthoringError',
      code: 'VALIDATION_ERROR',
      message: 'bad',
    });
    expect(bridge.requestForkConfirm).not.toHaveBeenCalled();
  });

  it('AuthoringError carries the server-supplied field details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'bad', details: { field: ['x'] } },
      })
    );

    const err = await authoringMutate('POST', '/x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(AuthoringError);
    expect((err as AuthoringError).details).toEqual({ field: ['x'] });
  });
});
