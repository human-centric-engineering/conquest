/**
 * Interviewer reviews — run / review the interviewer-policy judge panel for the selected version
 * (F18.8). Nested under the Settings tab, not a sibling workspace tab: the panel judges the house
 * rules, questioning arc and ask-as-written dial that tab already shows, and the workspace already
 * carries fifteen tabs.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PolicyEvaluationRunsTable } from '@/components/admin/questionnaires/policy/policy-evaluation-runs-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import type { PolicyEvaluationRunListItem } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Interviewer reviews · Questionnaire',
  description: 'Run and review the interviewer-policy judge panel for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

async function getRuns(id: string, versionId: string): Promise<PolicyEvaluationRunListItem[]> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionPolicyEvaluations(id, versionId)}?limit=50`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<PolicyEvaluationRunListItem[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('policy evaluations tab: runs fetch failed', err);
    return [];
  }
}

export default async function PolicyEvaluationsTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [detail, runs] = await Promise.all([getQuestionnaireDetailCached(id), getRuns(id, vid)]);
  if (!detail) notFound();
  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Run four independent reviewers over how this version’s interviewer is set up — the house
        rules, the questioning approach and pace, and which questions must be asked as written — and
        review the changes each one proposes.
      </p>

      <PolicyEvaluationRunsTable
        questionnaireId={id}
        versionId={vid}
        versionNumber={selected.versionNumber}
        runs={runs}
        canRun={true}
      />
    </div>
  );
}
