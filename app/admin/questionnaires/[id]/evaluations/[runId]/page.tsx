import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EvaluationRunDetail } from '@/components/admin/questionnaires/evaluation-run-detail';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type {
  EvaluationRunDetail as EvaluationRunDetailView,
  QuestionnaireDetail,
} from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Evaluation run',
  description: 'Findings from one design-time evaluation run.',
};

interface PageProps {
  params: Promise<{ id: string; runId: string }>;
  searchParams: Promise<{ v?: string }>;
}

async function getDetail(id: string): Promise<QuestionnaireDetail | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('evaluation run page: detail fetch failed', err);
    return null;
  }
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
    logger.error('evaluation run page: run fetch failed', err);
    return null;
  }
}

export default async function EvaluationRunPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id, runId } = await params;
  const { v } = await searchParams;
  // The detail route is version-scoped; admin pages carry the version in `?v=`, not the path.
  if (!v) notFound();

  const [detail, run] = await Promise.all([getDetail(id), getRun(id, v, runId)]);
  if (!detail || !run) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <Link href={`/admin/questionnaires/${id}`} className="hover:underline">
          {detail.title}
        </Link>
        {' / '}
        <Link href={`/admin/questionnaires/${id}/evaluations?v=${v}`} className="hover:underline">
          Evaluations
        </Link>
        {' / '}
        <span>Run</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Evaluation run</h1>
        <p className="text-muted-foreground text-sm">
          {new Date(run.createdAt).toLocaleString()} · {detail.title}
        </p>
      </header>

      <EvaluationRunDetail run={run} />
    </div>
  );
}
