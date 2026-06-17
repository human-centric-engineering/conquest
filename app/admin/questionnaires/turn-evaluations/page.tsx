import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TurnEvaluationsTable } from '@/components/admin/questionnaires/turn-evaluations-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import { isTurnEvaluationEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { TurnEvaluationListItem } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Turn evaluations',
  description: 'Search, review, and flag persisted interview-turn evaluations.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

/**
 * Pre-render the first page of persisted turn evaluations. Fetch failures never throw — the
 * table renders an empty state and re-fetches client-side on the first filter change.
 */
async function getEvaluations(): Promise<{
  items: TurnEvaluationListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.APP.TURN_EVALUATIONS.ROOT}?page=1&limit=25`);
    if (!res.ok) return { items: [], meta: EMPTY_META };
    const body = await parseApiResponse<TurnEvaluationListItem[]>(res);
    if (!body.success) return { items: [], meta: EMPTY_META };
    return { items: body.data, meta: parsePaginationMeta(body.meta) ?? EMPTY_META };
  } catch (err) {
    logger.error('turn evaluations page: initial fetch failed', err);
    return { items: [], meta: EMPTY_META };
  }
}

/**
 * Admin — persisted turn-evaluation search surface.
 *
 * Thin server component: gates on the turn-evaluation flag (404 when off — the surface is dark,
 * matching the API), pre-renders page 1 via `serverFetch`, and hands off to the client table for
 * search / filter / pagination / detail / review.
 */
export default async function TurnEvaluationsPage() {
  if (!(await isTurnEvaluationEnabled())) notFound();

  const { items, meta } = await getEvaluations();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Turn evaluations</h1>
        <p className="text-muted-foreground text-sm">
          Every persisted interview-turn verdict from the Preview Turn Inspector. Filter by score,
          effectiveness, model, or learning flag; open one to read the full verdict, leave a
          reviewer comment, and flag or action it into a learning dataset.
        </p>
      </header>

      <TurnEvaluationsTable initialItems={items} initialMeta={meta} />
    </div>
  );
}
