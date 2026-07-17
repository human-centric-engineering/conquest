/**
 * Evaluations tab — run / review design-time judge evaluations for the selected
 * version. Lifted into the workspace; reads `vid` from the path. History reads
 * under the master flag; the run button is gated by the design-evaluation sub-flag.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EvaluationRunsTable } from '@/components/admin/questionnaires/evaluation-runs-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import type { EvaluationRunListItem } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Evaluations · Questionnaire',
  description: 'Run and review the design-time judge evaluations for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

async function getRuns(id: string, versionId: string): Promise<EvaluationRunListItem[]> {
  try {
    // Most recent 50 (newest-first); the endpoint paginates at 20 by default and there is no
    // pager here, so lift the cap rather than silently truncate run history.
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionEvaluations(id, versionId)}?limit=50`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<EvaluationRunListItem[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('evaluations tab: runs fetch failed', err);
    return [];
  }
}

export default async function EvaluationsTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [detail, runs] = await Promise.all([getQuestionnaireDetailCached(id), getRuns(id, vid)]);
  if (!detail) notFound();
  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Run the seven design-time judges over this version’s structure and review their findings.
        Each run scores clarity, coverage, duplicates, type-fit, ordering, and audience/goal match,
        and lists the changes each judge proposes.
      </p>

      <EvaluationRunsTable
        questionnaireId={id}
        versionId={vid}
        versionNumber={selected.versionNumber}
        runs={runs}
        canRun={true}
      />
    </div>
  );
}
