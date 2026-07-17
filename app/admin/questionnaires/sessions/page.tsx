/**
 * Alpha session-ref browser (admin).
 *
 * A cross-questionnaire list of session support references + dates + statuses. Each ref opens the
 * session viewer (inspect the conversation + regenerate its report via the re-run panel); a sibling
 * link opens the version analytics. Deliberately ALPHA-ONLY — the surface exposes respondent-shaped
 * data that is protected once alpha ends, so it `notFound()`s unless the product is in the alpha
 * release stage AND the live-sessions flag is on (mirrors the API gate).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SessionRefBrowser } from '@/components/admin/questionnaires/sessions/session-ref-browser';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import { IS_ALPHA } from '@/lib/app/release-stage';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Session refs · Alpha',
  description: 'Browse session support references, open a session, and regenerate its report.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

/**
 * Pre-render page 1. Fetch failures never throw — the table renders an empty state and re-fetches
 * client-side on the first filter change.
 */
async function getSessions(): Promise<{ items: AdminSessionRefItem[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.APP.QUESTIONNAIRE_SESSIONS.REFS}?page=1&limit=25`);
    if (!res.ok) return { items: [], meta: EMPTY_META };
    const body = await parseApiResponse<AdminSessionRefItem[]>(res);
    if (!body.success) return { items: [], meta: EMPTY_META };
    return { items: body.data, meta: parsePaginationMeta(body.meta) ?? EMPTY_META };
  } catch (err) {
    logger.error('alpha session-ref page: initial fetch failed', err);
    return { items: [], meta: EMPTY_META };
  }
}

export default async function AlphaSessionRefsPage() {
  // Alpha-only surface: hidden entirely unless the product is in the alpha stage.
  if (!IS_ALPHA) notFound();

  const { items, meta } = await getSessions();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">Session references</h1>
          <span className="rounded border border-amber-300/70 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
            Alpha
          </span>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Every respondent session by its support reference. Click a reference to open the session —
          view the conversation and regenerate its report — or jump to that questionnaire&rsquo;s
          analytics. This browser is available during alpha only and is protected afterwards.
        </p>
      </header>

      <SessionRefBrowser initialItems={items} initialMeta={meta} />
    </div>
  );
}
