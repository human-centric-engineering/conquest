import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ExtractionChangesTable } from '@/components/admin/questionnaires/extraction-changes-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { QuestionnaireDetail } from '@/lib/app/questionnaire/views';
import type { ExtractionChangeListResponse } from '@/lib/app/questionnaire/extraction-review';

export const metadata: Metadata = {
  title: 'Extraction changes',
  description: 'Review and revert the extractor’s editorial decisions for a questionnaire version.',
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
    logger.error('extraction changes page: detail fetch failed', err);
    return null;
  }
}

async function getChanges(
  id: string,
  versionId: string
): Promise<ExtractionChangeListResponse | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionChanges(id, versionId));
    if (!res.ok) return null;
    const body = await parseApiResponse<ExtractionChangeListResponse>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('extraction changes page: changes fetch failed', err);
    return null;
  }
}

export default async function ExtractionChangesPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const { v } = await searchParams;

  const detail = await getDetail(id);
  if (!detail) notFound();

  // Version selection mirrors the detail page: `?v=` or the newest version.
  const selected = detail.versions.find((ver) => ver.id === v) ?? detail.versions[0] ?? null;
  const changes = selected ? await getChanges(id, selected.id) : null;

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
        <span>Extraction changes</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Extraction changes</h1>
        <p className="text-muted-foreground text-sm">
          Every editorial decision the extractor made — review the before/after and revert any of
          them. Reverting a launched version creates a new draft.
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
                  href={`/admin/questionnaires/${id}/extraction-changes?v=${ver.id}`}
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

          {changes ? (
            <ExtractionChangesTable
              questionnaireId={id}
              versionId={selected.id}
              changes={changes.changes}
              counts={changes.counts}
            />
          ) : (
            <p className="text-muted-foreground text-sm italic">
              Could not load this version’s extraction changes.
            </p>
          )}
        </>
      )}
    </div>
  );
}
