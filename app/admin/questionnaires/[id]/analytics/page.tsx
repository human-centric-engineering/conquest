import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AnalyticsView } from '@/components/admin/questionnaires/analytics/analytics-view';
import { ExportButtons } from '@/components/admin/questionnaires/analytics/export-buttons';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getAnalyticsDefaultDateInputs } from '@/lib/app/questionnaire/analytics';
import type {
  CompletionFunnelResult,
  QuestionDistributionsResult,
  QuestionnaireCostResult,
} from '@/lib/app/questionnaire/analytics';
import type { QuestionnaireDetail, TagView, VersionGraphView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Analytics',
  description: 'Per-question distributions, completion funnel, and cost actuals for a version.',
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; from?: string; to?: string; tagIds?: string }>;
}

/** Build the shared analytics query string (date window + tag filter). */
function buildQuery(sp: { from?: string; to?: string; tagIds?: string }): string {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.tagIds) qs.set('tagIds', sp.tagIds);
  return qs.toString() ? `?${qs.toString()}` : '';
}

async function getDetail(id: string): Promise<QuestionnaireDetail | null> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('analytics page: detail fetch failed', err);
    return null;
  }
}

async function getTagVocabulary(id: string, versionId: string): Promise<TagView[]> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionGraph(id, versionId));
    if (!res.ok) return [];
    const body = await parseApiResponse<VersionGraphView>(res);
    return body.success ? body.data.tags : [];
  } catch (err) {
    logger.error('analytics page: tag vocabulary fetch failed', err);
    return [];
  }
}

async function getDistributions(
  id: string,
  versionId: string,
  query: string
): Promise<QuestionDistributionsResult | null> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionAnalyticsDistributions(id, versionId)}${query}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionDistributionsResult>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('analytics page: distributions fetch failed', err);
    return null;
  }
}

async function getFunnel(
  id: string,
  versionId: string,
  query: string
): Promise<CompletionFunnelResult | null> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionAnalyticsFunnel(id, versionId)}${query}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<CompletionFunnelResult>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('analytics page: funnel fetch failed', err);
    return null;
  }
}

async function getCost(
  id: string,
  versionId: string,
  query: string
): Promise<QuestionnaireCostResult | null> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionAnalyticsCost(id, versionId)}${query}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<QuestionnaireCostResult>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('analytics page: cost fetch failed', err);
    return null;
  }
}

export default async function QuestionnaireAnalyticsPage({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const sp = await searchParams;

  const detail = await getDetail(id);
  if (!detail) notFound();

  // Version selection mirrors the detail/evaluations pages: `?v=` or the newest.
  const selected = detail.versions.find((ver) => ver.id === sp.v) ?? detail.versions[0] ?? null;

  const { from: defaultFrom, to: defaultTo } = getAnalyticsDefaultDateInputs();
  const filters = {
    from: sp.from || defaultFrom,
    to: sp.to || defaultTo,
    tagIds: (sp.tagIds ?? '').split(',').filter((t) => t.length > 0),
  };
  const query = buildQuery(sp);

  const [tagVocabulary, distributions, funnel, cost] = selected
    ? await Promise.all([
        getTagVocabulary(id, selected.id),
        getDistributions(id, selected.id, query),
        getFunnel(id, selected.id, query),
        getCost(id, selected.id, query),
      ])
    : [[] as TagView[], null, null, null];

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
        <span>Analytics</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-muted-foreground text-sm">
          The read-side view of completed-session data for a version: per-question distributions,
          the invitation completion funnel, and cost actuals. Aggregate-only — individual free-text
          answers are never shown.
        </p>
      </header>

      {detail.versions.length === 0 || !selected ? (
        <p className="text-muted-foreground text-sm italic">This questionnaire has no versions.</p>
      ) : (
        <>
          {/* Version selector — SSR links that set ?v= on this sub-route. */}
          <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
            <div className="flex flex-wrap gap-2">
              {detail.versions.map((ver) => {
                const active = ver.id === selected.id;
                return (
                  <Link
                    key={ver.id}
                    href={`/admin/questionnaires/${id}/analytics?v=${ver.id}`}
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
            <ExportButtons questionnaireId={id} versionId={selected.id} query={query} />
          </div>

          <AnalyticsView
            tagVocabulary={tagVocabulary}
            distributions={distributions}
            funnel={funnel}
            cost={cost}
            filters={filters}
          />
        </>
      )}
    </div>
  );
}
