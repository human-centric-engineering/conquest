/**
 * Scope evaluation run detail — findings from one Conditional Topics evaluation run (F17.21).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { ScopeEvaluationRunDetail } from '@/components/admin/questionnaires/topics/scope-evaluation-run-detail';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import type { ScopeEvaluationRunDetail as ScopeEvaluationRunDetailView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Review of this setup · Questionnaire',
  description: 'Findings from one Conditional Topics evaluation run.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string; runId: string }>;
}

async function getRun(
  id: string,
  versionId: string,
  runId: string
): Promise<ScopeEvaluationRunDetailView | null> {
  try {
    const res = await serverFetch(
      API.APP.QUESTIONNAIRES.versionScopeEvaluationById(id, versionId, runId)
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<ScopeEvaluationRunDetailView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('scope evaluation run tab: run fetch failed', err);
    return null;
  }
}

export default async function ScopeEvaluationRunTab({ params }: PageProps) {
  const { id, vid, runId } = await params;
  const run = await getRun(id, vid, runId);
  if (!run) notFound();

  return (
    <div className="w-full max-w-5xl space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href={`${workspaceVersionBase(id, vid)}/topics/evaluations`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> Past reviews
        </Link>
      </div>

      <ScopeEvaluationRunDetail run={run} questionnaireId={id} versionId={vid} canApply={true} />
    </div>
  );
}
