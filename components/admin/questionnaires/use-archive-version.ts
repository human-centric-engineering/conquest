'use client';

/**
 * Shared client hook for the per-version soft-archive pair: Archive + Restore.
 *
 * `archive(qId, vId)` POSTs `…/versions/:vid/archive` (stamps `archivedAt`); `restore(...)`
 * POSTs `…/versions/:vid/restore` (clears it). Both are idempotent server-side and orthogonal
 * to the version's `status`. Neither navigates — the caller refreshes the page on success — so
 * the hook just reports pending/error state and returns a success boolean. Mirrors
 * `useArchiveQuestionnaire` (the questionnaire-level pair).
 */

import { useState } from 'react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface UseArchiveVersion {
  /** Archive (soft-hide) the version. Resolves true on success, false on failure. */
  archive: (questionnaireId: string, versionId: string) => Promise<boolean>;
  /** Restore an archived version to the default version list. Resolves true on success. */
  restore: (questionnaireId: string, versionId: string) => Promise<boolean>;
  /** True while either mutation is in flight — disables triggers. */
  isPending: boolean;
  error: string | null;
  /** Clear the current error (e.g. before a retry). */
  clearError: () => void;
}

export function useArchiveVersion(): UseArchiveVersion {
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

  const archive = (questionnaireId: string, versionId: string): Promise<boolean> =>
    run(
      () =>
        apiClient.post(API.APP.QUESTIONNAIRES.versionArchive(questionnaireId, versionId), {
          body: {},
        }),
      'Could not archive the version.'
    );

  const restore = (questionnaireId: string, versionId: string): Promise<boolean> =>
    run(
      () =>
        apiClient.post(API.APP.QUESTIONNAIRES.versionRestore(questionnaireId, versionId), {
          body: {},
        }),
      'Could not restore the version.'
    );

  return { archive, restore, isPending, error, clearError: () => setError(null) };
}
