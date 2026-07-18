/**
 * Alpha session browser (admin).
 *
 * A cross-questionnaire console over respondent sessions: a KPI + charts overview, a URL-driven filter
 * bar (status, type, questionnaire, client, cohort, round, date window), and a sortable, paginated
 * table. Each row opens a slide-over with the conversation transcript + generated report (and a
 * regenerate action) WITHOUT navigating away, so the list never loses position. Deliberately ALPHA-ONLY
 * — the surface exposes respondent-shaped data that is protected once alpha ends, so it `notFound()`s
 * unless the product is in the alpha stage (mirrors the API gate — the alpha stage is the only gate;
 * there is no separate feature flag on this surface).
 *
 * All list/stats state lives in the URL: this server page reads `searchParams`, seeds the already-
 * filtered first page + stats + filter options, and the client re-fetches on any URL change.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SessionRefBrowser } from '@/components/admin/questionnaires/sessions/session-ref-browser';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import { IS_ALPHA } from '@/lib/app/release-stage';
import {
  loadAdminSessionFilterOptions,
  type AdminSessionRefItem,
  type AdminSessionFilterOptions,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { AdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Sessions · Alpha',
  description:
    'Browse respondent sessions, filter and chart them, and open a conversation + report.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };
const EMPTY_STATS: AdminSessionStats = {
  total: 0,
  completed: 0,
  active: 0,
  avgCompletion: 0,
  byStatus: [],
  overTime: [],
  completionBuckets: [],
  byClient: [],
  byQuestionnaire: [],
};

type SearchParams = Record<string, string | string[] | undefined>;

/** Forward the page's search params verbatim to the list/stats endpoints (they validate + ignore unknowns). */
function toQueryString(sp: SearchParams): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') params.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === 'string') params.set(k, v[0]);
  }
  return params.toString();
}

/** Pre-render the first (filtered) page + stats. Fetch failures never throw — the client re-fetches. */
async function seed(
  qs: string
): Promise<{ items: AdminSessionRefItem[]; meta: PaginationMeta; stats: AdminSessionStats }> {
  const suffix = qs ? `?${qs}` : '';
  try {
    const [listRes, statsRes] = await Promise.all([
      serverFetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS}${suffix}`),
      serverFetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS_STATS}${suffix}`),
    ]);
    const listBody = listRes.ok
      ? await parseApiResponse<AdminSessionRefItem[]>(listRes)
      : { success: false as const };
    const statsBody = statsRes.ok
      ? await parseApiResponse<AdminSessionStats>(statsRes)
      : { success: false as const };
    return {
      items: listBody.success ? listBody.data : [],
      meta: listBody.success ? (parsePaginationMeta(listBody.meta) ?? EMPTY_META) : EMPTY_META,
      stats: statsBody.success ? statsBody.data : EMPTY_STATS,
    };
  } catch (err) {
    logger.error('alpha sessions page: initial seed failed', err);
    return { items: [], meta: EMPTY_META, stats: EMPTY_STATS };
  }
}

export default async function AlphaSessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Alpha-only surface: hidden entirely unless the product is in the alpha stage.
  if (!IS_ALPHA) notFound();

  const sp = await searchParams;
  const qs = toQueryString(sp);

  let options: AdminSessionFilterOptions;
  try {
    options = await loadAdminSessionFilterOptions();
  } catch (err) {
    logger.error('alpha sessions page: filter options failed', err);
    options = {
      clients: [],
      questionnaires: [],
      cohorts: [],
      rounds: [],
      hasOpenEnded: false,
      hasUnassignedClient: false,
    };
  }

  const { items, meta, stats } = await seed(qs);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <span className="rounded border border-amber-300/70 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
            Alpha
          </span>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Every respondent session across all questionnaires — filter, chart, and open one to read
          its conversation and report (and regenerate it). This browser is available during alpha
          only and is protected afterwards.
        </p>
      </header>

      <SessionRefBrowser
        initialItems={items}
        initialMeta={meta}
        initialStats={stats}
        options={options}
      />
    </div>
  );
}
