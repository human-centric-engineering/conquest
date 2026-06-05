import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EvaluationRunsTable } from '@/components/admin/questionnaires/evaluation-runs-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  isDesignEvaluationEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import type { EvaluationRunListItem, QuestionnaireDetail } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Design evaluations',
  description: 'Run and review the design-time judge evaluations for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

async function getDetail(id: string): Promise<QuestionnaireDetail | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('evaluations page: detail fetch failed', err);
    return null;
  }
}

async function getRuns(id: string, versionId: string): Promise<EvaluationRunListItem[]> {
  try {
    // Fetch the most recent 50 (newest-first). The list endpoint paginates at 20 by
    // default; without a pagination UI here we lift the cap so run history isn't silently
    // truncated. A full pager is deferred (mirrors the orchestration runs list).
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionEvaluations(id, versionId)}?limit=50`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<EvaluationRunListItem[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('evaluations page: runs fetch failed', err);
    return [];
  }
}

export default async function EvaluationsPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const { v } = await searchParams;

  const detail = await getDetail(id);
  if (!detail) notFound();

  // Version selection mirrors the detail page: `?v=` or the newest version.
  const selected = detail.versions.find((ver) => ver.id === v) ?? detail.versions[0] ?? null;
  const runs = selected ? await getRuns(id, selected.id) : [];
  // The run button is sub-flag gated (the POST 404s when off); history reads under the master flag.
  const canRun = await isDesignEvaluationEnabled();

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
        <span>Evaluations</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Design evaluations</h1>
        <p className="text-muted-foreground text-sm">
          Run the seven design-time judges over a version’s structure and review their findings.
          Each run scores clarity, coverage, duplicates, type-fit, ordering, and audience/goal
          match, and lists the changes each judge proposes.
        </p>
      </header>

      {detail.versions.length === 0 || !selected ? (
        <p className="text-muted-foreground text-sm italic">This questionnaire has no versions.</p>
      ) : (
        <>
          {/* Version selector — SSR links that set ?v= on this sub-route. */}
          <div className="flex flex-wrap gap-2 border-b pb-3">
            {detail.versions.map((ver) => {
              const active = ver.id === selected.id;
              return (
                <Link
                  key={ver.id}
                  href={`/admin/questionnaires/${id}/evaluations?v=${ver.id}`}
                  scroll={false}
                  className={
                    active
                      ? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
                      : 'hover:bg-accent rounded-md border px-3 py-1.5 text-sm'
                  }
                >
                  v{ver.versionNumber}
                  <span className={active ? 'opacity-80' : 'text-muted-foreground'}>
                    {' '}
                    · {ver.status}
                  </span>
                </Link>
              );
            })}
          </div>

          <EvaluationRunsTable
            questionnaireId={id}
            versionId={selected.id}
            versionNumber={selected.versionNumber}
            runs={runs}
            canRun={canRun}
          />
        </>
      )}
    </div>
  );
}
