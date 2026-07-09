'use client';

/**
 * Client data hooks for the Behind-the-Scenes visualizer.
 *
 * `useWorkflowDetail` fetches a diagram + enrichment on demand (re-fetching when
 * the version lens changes); `useQuestionnaireOptions` populates the lens
 * selector from the questionnaires list. The initial summary list is passed from
 * the server component, then re-fetched with a lens via `fetchWorkflowSummaries`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { WorkflowSummary } from '@/lib/app/questionnaire/workflows/types';
import type { WorkflowDetail } from '@/lib/app/questionnaire/workflows/views';

/** One selectable questionnaire in the lens (we lens on its latest version). */
export interface QuestionnaireOption {
  id: string;
  title: string;
  status: string;
  versionId: string;
  versionNumber: number;
  versionStatus: string;
}

interface QuestionnaireListItem {
  id: string;
  title: string;
  status: string;
  latestVersion: { id: string; versionNumber: number; status: string } | null;
}

/** Fetch the workflow summaries, optionally tinted by a version lens. */
export async function fetchWorkflowSummaries(versionId?: string): Promise<WorkflowSummary[]> {
  const data = await apiClient.get<{ workflows: WorkflowSummary[] }>(
    API.APP.QUESTIONNAIRES.workflows,
    versionId ? { params: { versionId } } : undefined
  );
  return data.workflows;
}

interface WorkflowDetailState {
  detail: WorkflowDetail | null;
  loading: boolean;
  error: string | null;
}

/** Fetch one workflow's diagram + enrichment, optionally with a version lens. */
export function useWorkflowDetail(slug: string | null, versionId?: string): WorkflowDetailState {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .get<{ workflow: WorkflowDetail }>(
        API.APP.QUESTIONNAIRES.workflowById(slug),
        versionId ? { params: { versionId } } : undefined
      )
      .then((data) => {
        if (!cancelled) setDetail(data.workflow);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load workflow');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, versionId]);

  return { detail, loading, error };
}

interface QuestionnaireOptionsState {
  options: QuestionnaireOption[];
  loading: boolean;
  load: () => Promise<void>;
}

/** Load the questionnaires list for the lens selector (best-effort, once). */
export function useQuestionnaireOptions(): QuestionnaireOptionsState {
  const [options, setOptions] = useState<QuestionnaireOption[]>([]);
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    try {
      const data = await apiClient.get<{ items: QuestionnaireListItem[]; total: number }>(
        API.APP.QUESTIONNAIRES.ROOT,
        { params: { limit: 100, sortBy: 'updatedAt', sortOrder: 'desc' } }
      );
      setOptions(
        data.items
          .filter(
            (
              i
            ): i is QuestionnaireListItem & {
              latestVersion: NonNullable<QuestionnaireListItem['latestVersion']>;
            } => Boolean(i.latestVersion)
          )
          .map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            versionId: i.latestVersion.id,
            versionNumber: i.latestVersion.versionNumber,
            versionStatus: i.latestVersion.status,
          }))
      );
    } catch {
      // Lens is best-effort; a failed list just leaves the selector empty.
    } finally {
      setLoading(false);
    }
  }, []);

  return { options, loading, load };
}
