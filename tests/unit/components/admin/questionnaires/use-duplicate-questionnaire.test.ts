/**
 * useDuplicateQuestionnaire — shared client hook for the "Duplicate" action.
 *
 * Test Coverage:
 * - duplicate(): sets isDuplicating, POSTs to the correct endpoint
 * - duplicate(): on success, navigates to the new questionnaire and returns its id
 * - duplicate(): keeps isDuplicating true through navigation on success
 * - duplicate(): on APIClientError, sets the error message, resets isDuplicating, returns null
 * - duplicate(): on generic Error, sets the generic fallback message
 * - clearError(): resets error to null
 *
 * @see components/admin/questionnaires/use-duplicate-questionnaire.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Stable mock references captured via closure — same pattern as sibling test
// intro-background-field.test.tsx.
const apiPost = vi.fn();
const mockPush = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: (...args: unknown[]) => apiPost(...args) },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

import { useDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDuplicateQuestionnaire', () => {
  describe('duplicate()', () => {
    it('POSTs to the questionnaire duplicate endpoint derived from the given id', async () => {
      // Arrange: successful response with a new questionnaire id
      apiPost.mockResolvedValue({ questionnaireId: 'new-q', versionId: 'new-v' });
      const { result } = renderHook(() => useDuplicateQuestionnaire());

      // Act
      await act(async () => {
        await result.current.duplicate('source-q-1');
      });

      // Assert: the URL is derived from the input id — proves the hook transforms
      // the input into the correct endpoint, not a hardcoded URL.
      expect(apiPost).toHaveBeenCalledWith('/api/v1/app/questionnaires/source-q-1/duplicate', {
        body: {},
      });
    });

    it('navigates to /admin/questionnaires/{newId} on success', async () => {
      // Arrange
      apiPost.mockResolvedValue({ questionnaireId: 'new-q-id', versionId: 'v-1' });
      const { result } = renderHook(() => useDuplicateQuestionnaire());

      // Act
      await act(async () => {
        await result.current.duplicate('q-1');
      });

      // Assert: router.push is called with the path built from the response's
      // questionnaireId — not versionId or any other field.
      expect(mockPush).toHaveBeenCalledWith('/admin/questionnaires/new-q-id');
    });

    it('returns the new questionnaire id on success', async () => {
      // Arrange
      apiPost.mockResolvedValue({ questionnaireId: 'returned-id', versionId: 'v-1' });
      const { result } = renderHook(() => useDuplicateQuestionnaire());

      // Act
      let returnedId: string | null = null;
      await act(async () => {
        returnedId = await result.current.duplicate('q-1');
      });

      // Assert: return value matches the id used in the push — both extracted from
      // the same response field (questionnaireId), proving the hook doesn't mix them.
      expect(returnedId).toBe('returned-id');
      expect(mockPush).toHaveBeenCalledWith('/admin/questionnaires/returned-id');
    });

    it('keeps isDuplicating true after success to disable triggers through navigation', async () => {
      // Arrange
      apiPost.mockResolvedValue({ questionnaireId: 'new-q', versionId: 'new-v' });
      const { result } = renderHook(() => useDuplicateQuestionnaire());

      // Act
      await act(async () => {
        await result.current.duplicate('q-1');
      });

      // Assert: isDuplicating intentionally stays true so the UI remains disabled
      // while the router push is in progress.
      expect(result.current.isDuplicating).toBe(true);
    });

    describe('on APIClientError', () => {
      it('sets the error to the APIClientError message', async () => {
        // Arrange
        const { APIClientError } = await import('@/lib/api/client');
        apiPost.mockRejectedValue(new APIClientError('Duplicate not allowed'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        await act(async () => {
          await result.current.duplicate('q-1');
        });

        // Assert: the specific API error is surfaced
        expect(result.current.error).toBe('Duplicate not allowed');
      });

      it('returns null', async () => {
        // Arrange
        const { APIClientError } = await import('@/lib/api/client');
        apiPost.mockRejectedValue(new APIClientError('Not found'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        let returnedValue: string | null | undefined;
        await act(async () => {
          returnedValue = await result.current.duplicate('q-1');
        });

        // Assert
        expect(returnedValue).toBeNull();
      });

      it('resets isDuplicating to false', async () => {
        // Arrange
        const { APIClientError } = await import('@/lib/api/client');
        apiPost.mockRejectedValue(new APIClientError('Server error'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        await act(async () => {
          await result.current.duplicate('q-1');
        });

        // Assert: isDuplicating is reset so the user can retry
        expect(result.current.isDuplicating).toBe(false);
      });

      it('does not navigate on failure', async () => {
        // Arrange
        const { APIClientError } = await import('@/lib/api/client');
        apiPost.mockRejectedValue(new APIClientError('Server error'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        await act(async () => {
          await result.current.duplicate('q-1');
        });

        // Assert
        expect(mockPush).not.toHaveBeenCalled();
      });
    });

    describe('on a non-APIClientError throw', () => {
      it('sets the generic fallback error message', async () => {
        // Arrange: throw a plain Error (e.g. network failure)
        apiPost.mockRejectedValue(new Error('Network timeout'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        await act(async () => {
          await result.current.duplicate('q-1');
        });

        // Assert: generic message rather than the raw error text
        expect(result.current.error).toBe('Could not duplicate the questionnaire.');
      });

      it('resets isDuplicating to false', async () => {
        // Arrange
        apiPost.mockRejectedValue(new Error('Network timeout'));
        const { result } = renderHook(() => useDuplicateQuestionnaire());

        // Act
        await act(async () => {
          await result.current.duplicate('q-1');
        });

        // Assert
        expect(result.current.isDuplicating).toBe(false);
      });
    });
  });

  describe('clearError()', () => {
    it('resets the error to null', async () => {
      // Arrange: put the hook into an error state first
      const { APIClientError } = await import('@/lib/api/client');
      apiPost.mockRejectedValue(new APIClientError('Something failed'));
      const { result } = renderHook(() => useDuplicateQuestionnaire());

      await act(async () => {
        await result.current.duplicate('q-1');
      });
      expect(result.current.error).not.toBeNull();

      // Act
      act(() => {
        result.current.clearError();
      });

      // Assert: error is cleared — the hook did something beyond just returning a value
      expect(result.current.error).toBeNull();
    });
  });
});
