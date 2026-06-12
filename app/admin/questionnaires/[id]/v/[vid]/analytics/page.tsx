/**
 * Analytics tab — read-side completed-session view for the selected version.
 *
 * Lifted into the workspace: the shared layout supplies the header, version
 * selector, and tabs, so this page reads `vid` from the path and renders only the
 * analytics body (filters, distributions, funnel, cost). Date-window and tag
 * filters stay in `searchParams` — legitimate page-level state a page may read.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AnalyticsView } from '@/components/admin/questionnaires/analytics/analytics-view';
import { ExportButtons } from '@/components/admin/questionnaires/analytics/export-buttons';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getAnalyticsDefaultDateInputs } from '@/lib/app/questionnaire/analytics';
import { getVersionGraphCached } from '@/lib/app/questionnaire/workspace-data';
import type {
  CompletionFunnelResult,
  QuestionDistributionsResult,
  QuestionnaireCostResult,
} from '@/lib/app/questionnaire/analytics';
import type { TagView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Analytics · Questionnaire',
  description: 'Per-question distributions, completion funnel, and cost actuals for a version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ from?: string; to?: string; tagIds?: string }>;
}

/** Build the shared analytics query string (date window + tag filter). */
function buildQuery(sp: { from?: string; to?: string; tagIds?: string }): string {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.tagIds) qs.set('tagIds', sp.tagIds);
  return qs.toString() ? `?${qs.toString()}` : '';
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
    logger.error('analytics tab: distributions fetch failed', err);
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
    logger.error('analytics tab: funnel fetch failed', err);
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
    logger.error('analytics tab: cost fetch failed', err);
    return null;
  }
}

export default async function AnalyticsTab({ params, searchParams }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id, vid } = await params;
  const sp = await searchParams;

  const { from: defaultFrom, to: defaultTo } = getAnalyticsDefaultDateInputs();
  const filters = {
    from: sp.from || defaultFrom,
    to: sp.to || defaultTo,
    tagIds: (sp.tagIds ?? '').split(',').filter((t) => t.length > 0),
  };
  const query = buildQuery(sp);

  const graph = await getVersionGraphCached(id, vid);
  const tagVocabulary: TagView[] = graph?.tags ?? [];
  const [distributions, funnel, cost] = await Promise.all([
    getDistributions(id, vid, query),
    getFunnel(id, vid, query),
    getCost(id, vid, query),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Aggregate completed-session data — per-question distributions, the invitation completion
          funnel, and cost actuals. Individual free-text answers are never shown.
        </p>
        <ExportButtons questionnaireId={id} versionId={vid} query={query} />
      </div>

      <AnalyticsView
        tagVocabulary={tagVocabulary}
        distributions={distributions}
        funnel={funnel}
        cost={cost}
        filters={filters}
      />
    </div>
  );
}
