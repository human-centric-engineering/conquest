'use client';

/**
 * Shared client hook for the general-purpose "Duplicate questionnaire" action.
 *
 * POSTs to `…/:id/duplicate` (a plain, unattributed copy of the current version —
 * structure, settings, data slots, scoring; no respondent data) and, on success,
 * navigates to the new draft so the admin lands on the copy. Errors are surfaced
 * via the returned `error` string (no toast system in this app) — call sites
 * decide where to render it.
 *
 * Used by every Duplicate affordance — the list-row menu, the workspace-header
 * button, and the Export / download menu — so they share one implementation.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface DuplicateResult {
  questionnaireId: string;
  versionId: string;
}

export interface UseDuplicateQuestionnaire {
  /** Duplicate the questionnaire and navigate to the new draft. Returns the new id, or null on failure. */
  duplicate: (questionnaireId: string) => Promise<string | null>;
  isDuplicating: boolean;
  error: string | null;
  /** Clear the current error (e.g. before a retry). */
  clearError: () => void;
}

export function useDuplicateQuestionnaire(): UseDuplicateQuestionnaire {
  const router = useRouter();
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicate = async (questionnaireId: string): Promise<string | null> => {
    setIsDuplicating(true);
    setError(null);
    try {
      const data = await apiClient.post<DuplicateResult>(
        API.APP.QUESTIONNAIRES.duplicate(questionnaireId),
        {
          body: {},
        }
      );
      // Land on the new draft. Keep `isDuplicating` true through navigation so triggers stay disabled.
      router.push(`/admin/questionnaires/${data.questionnaireId}`);
      return data.questionnaireId;
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not duplicate the questionnaire.'
      );
      setIsDuplicating(false);
      return null;
    }
  };

  return { duplicate, isDuplicating, error, clearError: () => setError(null) };
}
