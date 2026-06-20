/**
 * Rounds tab — every round across the demo client's cohorts.
 *
 * Server component: gates on the `APP_QUESTIONNAIRES_COHORTS` flag, fetches the enriched
 * round list (scoped by `demoClientId`) via `serverFetch`, and hands off to the client
 * `<RoundsTable scope="client">` (search + per-row Close on open rounds). Fetch failures
 * render an empty list, never throw.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS`. DEMO-ONLY (F2.5.1 lineage).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { RoundsTable } from '@/components/admin/cohorts/rounds-table';
import { SectionHeading } from '@/components/admin/cohorts/cohort-ui';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { RoundView } from '@/lib/app/questionnaire/rounds';

export const metadata: Metadata = {
  title: 'Rounds · Demo client',
  description: 'Every time-bound round across this demo client’s cohorts.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getRounds(demoClientId: string): Promise<RoundView[]> {
  try {
    const res = await serverFetch(`${API.APP.ROUNDS.ROOT}?demoClientId=${demoClientId}`);
    if (!res.ok) return [];
    const body = await parseApiResponse<RoundView[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('rounds tab: initial fetch failed', err);
    return [];
  }
}

export default async function DemoClientRoundsTab({ params }: PageProps) {
  if (!(await isCohortsEnabled())) notFound();

  const { id } = await params;
  const rounds = await getRounds(id);

  const totalStarted = rounds.reduce((sum, r) => sum + r.stats.sessionsStarted, 0);
  const totalCompleted = rounds.reduce((sum, r) => sum + r.stats.sessionsCompleted, 0);
  const statTiles: CqStat[] = [
    { label: 'Rounds', value: rounds.length },
    {
      label: 'Open',
      value: rounds.filter((r) => r.status === 'open').length,
      accent: true,
    },
    {
      label: 'Completion',
      value: totalStarted === 0 ? '—' : `${Math.round((totalCompleted / totalStarted) * 100)}%`,
      hint: `${totalCompleted} of ${totalStarted} sessions`,
    },
  ];

  return (
    <div className="space-y-6">
      <SectionHeading title="Rounds">
        Time-bound deliveries of questionnaires to this client&rsquo;s cohorts. Create a round from
        a cohort&rsquo;s detail page; open the round to attach questionnaires.
      </SectionHeading>

      <CqStatTiles stats={statTiles} />

      <RoundsTable scope="client" demoClientId={id} rounds={rounds} />
    </div>
  );
}
