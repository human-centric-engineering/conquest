'use client';

/**
 * Shared client hook for the questionnaire soft-delete pair: Archive + Restore.
 *
 * `archive(id)` DELETEs `…/:id` (stamps `archivedAt`); `restore(id)` POSTs to
 * `…/:id/restore` (clears it). Both are idempotent server-side. Neither navigates —
 * the list-row menu is the only caller, and it refetches the current page on
 * success — so the hook just reports pending/error state and returns a success
 * boolean. Errors surface via the returned `error` string (no toast system here);
 * the call site decides where to render it. Mirrors `useDuplicateQuestionnaire`.
 */

import { useState } from 'react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface UseArchiveQuestionnaire {
  /** Archive (soft-delete) the questionnaire. Resolves true on success, false on failure. */
  archive: (questionnaireId: string) => Promise<boolean>;
  /** Restore an archived questionnaire to the active list. Resolves true on success. */
  restore: (questionnaireId: string) => Promise<boolean>;
  /** True while either mutation is in flight — disables triggers. */
  isPending: boolean;
  error: string | null;
  /** Clear the current error (e.g. before a retry). */
  clearError: () => void;
}

export function useArchiveQuestionnaire(): UseArchiveQuestionnaire {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: () => Promise<unknown>, fallbackMessage: string): Promise<boolean> => {
    setIsPending(true);
    setError(null);
    try {
      await op();
      setIsPending(false);
      return true;
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : fallbackMessage);
      setIsPending(false);
      return false;
    }
  };

  const archive = (questionnaireId: string): Promise<boolean> =>
    run(
      () => apiClient.delete(API.APP.QUESTIONNAIRES.byId(questionnaireId)),
      'Could not archive the questionnaire.'
    );

  const restore = (questionnaireId: string): Promise<boolean> =>
    run(
      () => apiClient.post(API.APP.QUESTIONNAIRES.restore(questionnaireId), { body: {} }),
      'Could not restore the questionnaire.'
    );

  return { archive, restore, isPending, error, clearError: () => setError(null) };
}
