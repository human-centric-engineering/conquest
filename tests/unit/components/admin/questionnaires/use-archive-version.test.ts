/**
 * useArchiveVersion — shared client hook for the per-version Archive + Restore actions.
 *
 * Test Coverage:
 * - archive(): POSTs the versionArchive endpoint (derived from both ids), resolves true
 * - restore(): POSTs the versionRestore endpoint, resolves true
 * - archive()/restore(): on APIClientError, surface the message, resolve false, reset pending
 * - archive()/restore(): on a generic Error, use the action-specific fallback message
 * - clearError(): resets error to null
 *
 * @see components/admin/questionnaires/use-archive-version.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: (...args: unknown[]) => apiPost(...args) },
  APIClientError: class APIClientError extends Error {},
}));

import { useArchiveVersion } from '@/components/admin/questionnaires/use-archive-version';

const QID = 'qn-9';
const VID = 'ver-3';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useArchiveVersion', () => {
  describe('archive()', () => {
    it('POSTs the versionArchive endpoint derived from both ids and resolves true', async () => {
      apiPost.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArchiveVersion());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.archive(QID, VID);
      });

      // URL derived from BOTH ids — proves the hook builds the version-scoped endpoint.
      expect(apiPost).toHaveBeenCalledWith(
        `/api/v1/app/questionnaires/${QID}/versions/${VID}/archive`,
        { body: {} }
      );
      expect(ok).toBe(true);
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('on APIClientError, surfaces the message, resolves false, resets pending', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      apiPost.mockRejectedValue(new APIClientError('Archive blocked'));
      const { result } = renderHook(() => useArchiveVersion());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.archive(QID, VID);
      });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('Archive blocked');
      expect(result.current.isPending).toBe(false);
    });

    it('on a generic Error, uses the archive-specific fallback message', async () => {
      apiPost.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useArchiveVersion());

      await act(async () => {
        await result.current.archive(QID, VID);
      });

      expect(result.current.error).toBe('Could not archive the version.');
    });
  });

  describe('restore()', () => {
    it('POSTs the versionRestore endpoint with an empty body and resolves true', async () => {
      apiPost.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArchiveVersion());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.restore(QID, VID);
      });

      expect(apiPost).toHaveBeenCalledWith(
        `/api/v1/app/questionnaires/${QID}/versions/${VID}/restore`,
        { body: {} }
      );
      expect(ok).toBe(true);
    });

    it('on a generic Error, uses the restore-specific fallback message', async () => {
      apiPost.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useArchiveVersion());

      await act(async () => {
        await result.current.restore(QID, VID);
      });

      expect(result.current.error).toBe('Could not restore the version.');
    });
  });

  it('clearError() resets the error to null', async () => {
    apiPost.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useArchiveVersion());

    await act(async () => {
      await result.current.archive(QID, VID);
    });
    expect(result.current.error).not.toBeNull();

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
