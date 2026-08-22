/**
 * Interviewer review detail — findings from one interviewer-policy judge run (F18.8).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { PolicyEvaluationRunDetail } from '@/components/admin/questionnaires/policy/policy-evaluation-run-detail';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import type { PolicyEvaluationRunDetail as PolicyEvaluationRunDetailView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Interviewer review · Questionnaire',
  description: 'Findings from one interviewer-policy judge run.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string; runId: string }>;
}

async function getRun(
  id: string,
  versionId: string,
  runId: string
): Promise<PolicyEvaluationRunDetailView | null> {
  try {
    const res = await serverFetch(
      API.APP.QUESTIONNAIRES.versionPolicyEvaluationById(id, versionId, runId)
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<PolicyEvaluationRunDetailView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('policy evaluation run tab: run fetch failed', err);
    return null;
  }
}

export default async function PolicyEvaluationRunTab({ params }: PageProps) {
  const { id, vid, runId } = await params;
  const run = await getRun(id, vid, runId);
  if (!run) notFound();

  return (
    <div className="w-full max-w-5xl space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href={`${workspaceVersionBase(id, vid)}/settings/policy-evaluations`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> Interviewer reviews
        </Link>
      </div>

      <PolicyEvaluationRunDetail run={run} questionnaireId={id} versionId={vid} canApply={true} />
    </div>
  );
}
