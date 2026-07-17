/**
 * useArchiveQuestionnaire — shared client hook for the Archive + Restore actions.
 *
 * Test Coverage:
 * - archive(): DELETEs the byId endpoint, resolves true, clears pending
 * - restore(): POSTs the restore endpoint with an empty body, resolves true
 * - archive()/restore(): on APIClientError, surface the message, resolve false, reset pending
 * - archive(): on a generic Error, use the archive-specific fallback message
 * - restore(): on a generic Error, use the restore-specific fallback message
 * - clearError(): resets error to null
 *
 * @see components/admin/questionnaires/use-archive-questionnaire.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiDelete = vi.fn();
const apiPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    delete: (...args: unknown[]) => apiDelete(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  APIClientError: class APIClientError extends Error {},
}));

import { useArchiveQuestionnaire } from '@/components/admin/questionnaires/use-archive-questionnaire';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useArchiveQuestionnaire', () => {
  describe('archive()', () => {
    it('DELETEs the byId endpoint derived from the given id and resolves true', async () => {
      apiDelete.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArchiveQuestionnaire());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.archive('qn-9');
      });

      // URL derived from the id — proves the hook builds the endpoint, not a constant.
      expect(apiDelete).toHaveBeenCalledWith('/api/v1/app/questionnaires/qn-9');
      expect(ok).toBe(true);
      // Unlike duplicate, archive resets pending on success (no navigation).
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('on APIClientError, surfaces the message, resolves false, resets pending', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      apiDelete.mockRejectedValue(new APIClientError('Archive blocked'));
      const { result } = renderHook(() => useArchiveQuestionnaire());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.archive('qn-1');
      });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('Archive blocked');
      expect(result.current.isPending).toBe(false);
    });

    it('on a generic Error, uses the archive-specific fallback message', async () => {
      apiDelete.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useArchiveQuestionnaire());

      await act(async () => {
        await result.current.archive('qn-1');
      });

      expect(result.current.error).toBe('Could not archive the questionnaire.');
    });
  });

  describe('restore()', () => {
    it('POSTs the restore endpoint with an empty body and resolves true', async () => {
      apiPost.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArchiveQuestionnaire());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.restore('qn-7');
      });

      expect(apiPost).toHaveBeenCalledWith('/api/v1/app/questionnaires/qn-7/restore', { body: {} });
      expect(ok).toBe(true);
      expect(result.current.isPending).toBe(false);
    });

    it('on a generic Error, uses the restore-specific fallback message and resolves false', async () => {
      apiPost.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useArchiveQuestionnaire());

      let ok: boolean | undefined;
      await act(async () => {
        ok = await result.current.restore('qn-1');
      });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('Could not restore the questionnaire.');
    });
  });

  describe('clearError()', () => {
    it('resets the error to null', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      apiDelete.mockRejectedValue(new APIClientError('boom'));
      const { result } = renderHook(() => useArchiveQuestionnaire());

      await act(async () => {
        await result.current.archive('qn-1');
      });
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.clearError();
      });
      expect(result.current.error).toBeNull();
    });
  });
});
