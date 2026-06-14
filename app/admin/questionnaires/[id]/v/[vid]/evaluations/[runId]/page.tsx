/**
 * Evaluation run detail — findings from one design-time evaluation run.
 *
 * Lifted into the workspace. The version now lives in the path (`/v/[vid]`), so
 * the old `if (!v) notFound()` guard — which existed only because the version was
 * a query param — is gone: a valid route always carries its version.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { EvaluationRunDetail } from '@/components/admin/questionnaires/evaluation-run-detail';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  isDataSlotsEnabled,
  isDesignEvaluationEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { getVersionDataSlotCountCached } from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import type { EvaluationRunDetail as EvaluationRunDetailView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Evaluation run · Questionnaire',
  description: 'Findings from one design-time evaluation run.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string; runId: string }>;
}

async function getRun(
  id: string,
  versionId: string,
  runId: string
): Promise<EvaluationRunDetailView | null> {
  try {
    const res = await serverFetch(
      API.APP.QUESTIONNAIRES.versionEvaluationById(id, versionId, runId)
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<EvaluationRunDetailView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('evaluation run tab: run fetch failed', err);
    return null;
  }
}

export default async function EvaluationRunTab({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id, vid, runId } = await params;
  const [run, canApply, dataSlotsEnabled] = await Promise.all([
    getRun(id, vid, runId),
    isDesignEvaluationEnabled(),
    isDataSlotsEnabled(),
  ]);
  if (!run) notFound();

  // Offer to slot a newly-added question only when the version already has data slots (a question
  // added afterwards would otherwise be orphaned from them).
  const dataSlotsAvailable = dataSlotsEnabled && (await getVersionDataSlotCountCached(id, vid)) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href={`${workspaceVersionBase(id, vid)}/evaluations`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> Evaluations
        </Link>
      </div>

      <EvaluationRunDetail
        run={run}
        questionnaireId={id}
        versionId={vid}
        canApply={canApply}
        dataSlotsAvailable={dataSlotsAvailable}
      />
    </div>
  );
}
