import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { VersionGraph } from '@/components/admin/questionnaires/version-graph';
import { QUESTIONNAIRE_STATUS_BADGE } from '@/components/admin/questionnaires/status-badge';
import { Badge } from '@/components/ui/badge';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { QuestionnaireDetail, VersionGraphView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Questionnaire',
  description: 'View a questionnaire’s versions and structure.',
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
    logger.error('questionnaire detail page: fetch failed', err);
    return null;
  }
}

async function getGraph(id: string, versionId: string): Promise<VersionGraphView | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionGraph(id, versionId));
    if (!res.ok) return null;
    const body = await parseApiResponse<VersionGraphView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('questionnaire version graph: fetch failed', err);
    return null;
  }
}

export default async function QuestionnaireDetailPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const { v } = await searchParams;

  const detail = await getDetail(id);
  if (!detail) notFound();

  // Version switching is SSR via the `?v=` query param (no client state needed).
  // Default to the newest version (the detail list is already newest-first).
  const selected = detail.versions.find((ver) => ver.id === v) ?? detail.versions[0] ?? null;
  const graph = selected ? await getGraph(id, selected.id) : null;

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-2 text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <span>{detail.title}</span>
      </nav>

      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{detail.title}</h1>
          <Badge variant={QUESTIONNAIRE_STATUS_BADGE[detail.status].variant}>
            {QUESTIONNAIRE_STATUS_BADGE[detail.status].label}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {detail.versions.length} version{detail.versions.length === 1 ? '' : 's'}
        </p>
      </header>

      {detail.versions.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">This questionnaire has no versions.</p>
      ) : (
        <>
          {/* Version selector — SSR links that set ?v= */}
          <div className="flex flex-wrap gap-2 border-b pb-3">
            {detail.versions.map((ver) => {
              const active = ver.id === selected?.id;
              return (
                <Link
                  key={ver.id}
                  href={`/admin/questionnaires/${id}?v=${ver.id}`}
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

          {selected && (
            <p className="text-muted-foreground text-sm">
              {selected.sectionCount} section{selected.sectionCount === 1 ? '' : 's'} ·{' '}
              {selected.questionCount} question{selected.questionCount === 1 ? '' : 's'} ·{' '}
              {selected.changeCount} extraction change{selected.changeCount === 1 ? '' : 's'}
            </p>
          )}

          {graph ? (
            <VersionGraph graph={graph} />
          ) : (
            <p className="text-muted-foreground text-sm italic">
              Could not load this version’s structure.
            </p>
          )}
        </>
      )}
    </div>
  );
}
