/**
 * Cohorts tab — the groups of people under a demo client.
 *
 * Server component: gates on the `APP_QUESTIONNAIRES_COHORTS` flag (404 when off, like
 * the demo-client layout gates on the questionnaires flag), fetches the enriched cohort
 * list via `serverFetch`, and hands off to the client `<CohortsTable>` (search + the
 * "New cohort" dialog). Fetch failures render an empty list, never throw.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS`. DEMO-ONLY (F2.5.1 lineage).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CohortsTable } from '@/components/admin/cohorts/cohorts-table';
import { SectionHeading } from '@/components/admin/cohorts/cohort-ui';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isCohortsEnabled, isIntroScreenEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { CohortView } from '@/lib/app/questionnaire/rounds';

export const metadata: Metadata = {
  title: 'Cohorts · Demo client',
  description: 'Groups of people under a demo client, and how their rounds are completing.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getCohorts(demoClientId: string): Promise<CohortView[]> {
  try {
    const res = await serverFetch(`${API.APP.COHORTS.ROOT}?demoClientId=${demoClientId}`);
    if (!res.ok) return [];
    const body = await parseApiResponse<CohortView[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('cohorts tab: initial fetch failed', err);
    return [];
  }
}

/** Weighted overall completion across all cohorts (completed ÷ started, not a mean of rates). */
function overallCompletionRate(cohorts: CohortView[]): number {
  const started = cohorts.reduce((sum, c) => sum + c.stats.sessionsStarted, 0);
  const completed = cohorts.reduce((sum, c) => sum + c.stats.sessionsCompleted, 0);
  return started === 0 ? 0 : completed / started;
}

export default async function DemoClientCohortsTab({ params }: PageProps) {
  if (!(await isCohortsEnabled())) notFound();

  const { id } = await params;
  const [cohorts, introScreenEnabled] = await Promise.all([getCohorts(id), isIntroScreenEnabled()]);

  const totalStarted = cohorts.reduce((sum, c) => sum + c.stats.sessionsStarted, 0);
  const statTiles: CqStat[] = [
    { label: 'Cohorts', value: cohorts.length },
    {
      label: 'Active members',
      value: cohorts.reduce((sum, c) => sum + c.memberCount, 0),
      accent: true,
    },
    {
      label: 'Completion',
      value: totalStarted === 0 ? '—' : `${Math.round(overallCompletionRate(cohorts) * 100)}%`,
      hint: 'across all rounds',
    },
  ];

  return (
    <div className="space-y-6">
      <SectionHeading title="Cohorts">
        Groups of people you deliver rounds of questionnaires to. Open a cohort to manage its roster
        and rounds.
      </SectionHeading>

      <CqStatTiles stats={statTiles} />

      <CohortsTable demoClientId={id} cohorts={cohorts} introScreenEnabled={introScreenEnabled} />
    </div>
  );
}
