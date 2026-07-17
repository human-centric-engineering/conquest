/**
 * Analytics tab — read-side completed-session view for the selected version.
 *
 * Lifted into the workspace: the shared layout supplies the header, version
 * selector, and tabs, so this page reads `vid` from the path and renders only the
 * analytics body (filters, distributions, funnel, cost). Date-window and tag
 * filters stay in `searchParams` — legitimate page-level state a page may read.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { AnalyticsView } from '@/components/admin/questionnaires/analytics/analytics-view';
import { ExportButtons } from '@/components/admin/questionnaires/analytics/export-buttons';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getAnalyticsDefaultDateInputs } from '@/lib/app/questionnaire/analytics';
import { getVersionGraphCached } from '@/lib/app/questionnaire/workspace-data';
import { listRoundsForVersion } from '@/app/api/v1/app/rounds/_lib/read';
import type {
  CompletionFunnelResult,
  QuestionDistributionsResult,
  QuestionnaireCostResult,
  SafeguardingSummary,
} from '@/lib/app/questionnaire/analytics';
import type { TagView } from '@/lib/app/questionnaire/views';

export const metadata: Metadata = {
  title: 'Analytics · Questionnaire',
  description: 'Per-question distributions, completion funnel, and cost actuals for a version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ from?: string; to?: string; tagIds?: string; roundId?: string }>;
}

/** Build the shared analytics query string (date window + tag filter + round scope). */
function buildQuery(sp: { from?: string; to?: string; tagIds?: string; roundId?: string }): string {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.tagIds) qs.set('tagIds', sp.tagIds);
  if (sp.roundId) qs.set('roundId', sp.roundId);
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

async function getSafeguarding(
  id: string,
  versionId: string,
  query: string
): Promise<SafeguardingSummary | null> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionAnalyticsSafeguarding(id, versionId)}${query}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<SafeguardingSummary>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('analytics tab: safeguarding fetch failed', err);
    return null;
  }
}

export default async function AnalyticsTab({ params, searchParams }: PageProps) {
  const { id, vid } = await params;
  const sp = await searchParams;

  const { from: defaultFrom, to: defaultTo } = getAnalyticsDefaultDateInputs();
  const filters = {
    from: sp.from || defaultFrom,
    to: sp.to || defaultTo,
    tagIds: (sp.tagIds ?? '').split(',').filter((t) => t.length > 0),
    roundId: sp.roundId || undefined,
  };
  const query = buildQuery(sp);

  const graph = await getVersionGraphCached(id, vid);
  const tagVocabulary: TagView[] = graph?.tags ?? [];
  // Round-scope options (Cohorts & Rounds): only rounds that actually produced sessions for this
  // version — so the selector appears just when it's useful.
  const roundScope = await listRoundsForVersion(vid);
  const [distributions, funnel, cost, safeguarding] = await Promise.all([
    getDistributions(id, vid, query),
    getFunnel(id, vid, query),
    getCost(id, vid, query),
    getSafeguarding(id, vid, query),
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

      {/* Safeguarding signal (sensitivity awareness): a lightweight count of sessions that flagged
          a sensitive disclosure. Counts only — never a summary or identity. Hidden when there's
          nothing flagged (or the cohort is k-anon suppressed) so it doesn't add noise. */}
      {safeguarding && !safeguarding.suppressed && safeguarding.flagged > 0 && (
        <div className="rounded-lg border border-teal-300/60 bg-teal-50/50 px-4 py-3 text-sm dark:border-teal-500/30 dark:bg-teal-500/10">
          <p className="text-foreground font-medium">Safeguarding</p>
          <p className="text-muted-foreground mt-0.5">
            {safeguarding.flagged} session{safeguarding.flagged === 1 ? '' : 's'} flagged a
            sensitive disclosure
            {safeguarding.serious > 0 ? ` (${safeguarding.serious} serious)` : ''}. Specifics are
            never shown here — handle with care.
          </p>
        </div>
      )}

      {/* Narrative teaser — the synthesis report turns these aggregates into a written narrative with
          recommendations. */}
      <Link
        href={`/admin/questionnaires/${id}/v/${vid}/cohort-report`}
        className="hover:border-foreground/30 hover:bg-muted/40 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm transition-colors"
      >
        <span className="text-foreground font-medium">
          Want the narrative?{' '}
          <span className="text-muted-foreground font-normal">Generate a version-wide report</span>
        </span>
        <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
      </Link>

      <AnalyticsView
        tagVocabulary={tagVocabulary}
        distributions={distributions}
        funnel={funnel}
        cost={cost}
        filters={filters}
        roundOptions={roundScope.rounds}
        hasOpenEnded={roundScope.hasOpenEnded}
      />
    </div>
  );
}
