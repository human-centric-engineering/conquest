/**
 * Scope evaluations — run / review Conditional Topics judge evaluations for the selected version
 * (F17.21). Nested under the Topics tab, not a sibling workspace tab — the panel judges the
 * topics/rules/settings that tab already shows.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ScopeEvaluationRunsTable } from '@/components/admin/questionnaires/topics/scope-evaluation-runs-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import type { ScopeEvaluationRunListItem } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Past reviews · Questionnaire',
  description:
    'Run and review the Conditional Topics judge evaluations for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

async function getRuns(id: string, versionId: string): Promise<ScopeEvaluationRunListItem[]> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionScopeEvaluations(id, versionId)}?limit=50`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<ScopeEvaluationRunListItem[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('scope evaluations tab: runs fetch failed', err);
    return [];
  }
}

export default async function ScopeEvaluationsTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [detail, runs] = await Promise.all([getQuestionnaireDetailCached(id), getRuns(id, vid)]);
  if (!detail) notFound();
  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Run four independent judges over this version’s Conditional Topics configuration — topics,
        hard rules, planner instructions, and the time budget — and review the changes each one
        proposes.
      </p>

      <ScopeEvaluationRunsTable
        questionnaireId={id}
        versionId={vid}
        versionNumber={selected.versionNumber}
        runs={runs}
        canRun={true}
      />
    </div>
  );
}
