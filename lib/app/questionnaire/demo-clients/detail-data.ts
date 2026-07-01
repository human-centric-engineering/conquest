/**
 * Shared server-side data for the demo-client **detail** surface (the tabbed
 * `/admin/demo-clients/[id]/…` pages) — the sibling of `workspace-data.ts`.
 *
 * The detail layout and each tab page both need the demo-client record.
 * `serverFetch` is `cache: 'no-store'`, so a naive layout-plus-page pair would
 * issue duplicate HTTP calls every render. Wrapping the fetcher in React
 * `cache()` collapses them to one call per id within a single request render
 * pass — the layout fetches the client, the active tab reuses it for free.
 *
 * Server-only in practice (call from server components / route handlers). Kept
 * out of the `demo-clients` barrel deliberately: it imports `serverFetch`, which
 * pulls `next/headers`, and must never reach a client bundle.
 */
import { cache } from 'react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type {
  AttributedDemoClient,
  AttributedQuestionnaireRow,
  DemoClientDetail,
  DemoClientView,
} from '@/lib/app/questionnaire/demo-clients';

/**
 * Demo-client detail (identity, theme, attributed questionnaires). `cache()`-wrapped
 * so the layout and the active tab share one fetch. Returns `null` on any failure —
 * the caller decides whether that is a `notFound()`.
 */
export const getDemoClientDetailCached = cache(
  async (id: string): Promise<DemoClientDetail | null> => {
    try {
      const res = await serverFetch(API.APP.DEMO_CLIENTS.byId(id));
      if (!res.ok) return null;
      const body = await parseApiResponse<DemoClientDetail>(res);
      return body.success ? body.data : null;
    } catch (err) {
      logger.error('demo client detail: fetch failed', err);
      return null;
    }
  }
);

/**
 * DEMO-ONLY (F2.5.1): other active demo clients, offered as reassignment targets on
 * each attributed-questionnaire row. Degrades to an empty list — the row menu still
 * offers "Make generic (detach)", which is enough to unblock a delete.
 */
export async function getReassignTargets(currentId: string): Promise<AttributedDemoClient[]> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<DemoClientView[]>(res);
    if (!body.success) return [];
    return body.data
      .filter((c) => c.isActive && c.id !== currentId)
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name }));
  } catch (err) {
    logger.error('demo client detail: reassign targets fetch failed', err);
    return [];
  }
}

/**
 * DEMO-ONLY (F2.5.1): questionnaires available to attribute to this client from the detail page —
 * the *generic* (unattributed) ones. Reassigning a questionnaire already branded as another client
 * stays in that client's row menu ("Reassign to"), so this list is deliberately the not-yet-branded
 * set. Degrades to an empty list, which the picker renders as a disabled "nothing to attribute" hint.
 */
export async function getAttributableQuestionnaires(): Promise<AttributedQuestionnaireRow[]> {
  try {
    const res = await serverFetch(`${API.APP.QUESTIONNAIRES.ROOT}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<QuestionnaireListItem[]>(res);
    if (!body.success) return [];
    return body.data
      .filter((q) => q.demoClient === null)
      .map((q) => ({ id: q.id, title: q.title, status: q.status }));
  } catch (err) {
    logger.error('demo client detail: attributable questionnaires fetch failed', err);
    return [];
  }
}
