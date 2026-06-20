/**
 * Cohort detail — one cohort's roster and its rounds.
 *
 * Server component: gates on the `APP_QUESTIONNAIRES_COHORTS` flag, fetches the cohort
 * detail (with its roster) and the cohort's rounds via `serverFetch`, then composes the
 * client panels (`<CohortMembersPanel>`, `<RoundsTable scope="cohort">`). A missing
 * cohort 404s; list fetch failures degrade to an empty section, never throw.
 *
 * Gated by `APP_QUESTIONNAIRES_COHORTS`. DEMO-ONLY (F2.5.1 lineage).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { CohortHeaderActions } from '@/components/admin/cohorts/cohort-header-actions';
import { CohortMembersPanel } from '@/components/admin/cohorts/cohort-members-panel';
import { RoundsTable } from '@/components/admin/cohorts/rounds-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { cohortsTabHref, type CohortDetail, type RoundView } from '@/lib/app/questionnaire/rounds';

export const metadata: Metadata = {
  title: 'Cohort · Demo client',
  description: 'A cohort’s roster and rounds.',
};

interface PageProps {
  params: Promise<{ id: string; cohortId: string }>;
}

async function getCohort(cohortId: string): Promise<CohortDetail | null> {
  try {
    const res = await serverFetch(API.APP.COHORTS.byId(cohortId));
    if (!res.ok) return null;
    const body = await parseApiResponse<CohortDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('cohort detail: fetch failed', err);
    return null;
  }
}

async function getCohortRounds(cohortId: string): Promise<RoundView[]> {
  try {
    const res = await serverFetch(`${API.APP.ROUNDS.ROOT}?cohortId=${cohortId}`);
    if (!res.ok) return [];
    const body = await parseApiResponse<RoundView[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('cohort detail: rounds fetch failed', err);
    return [];
  }
}

export default async function CohortDetailPage({ params }: PageProps) {
  if (!(await isCohortsEnabled())) notFound();

  const { id, cohortId } = await params;
  const cohort = await getCohort(cohortId);
  if (!cohort) notFound();

  const rounds = await getCohortRounds(cohortId);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link
          href={cohortsTabHref(id)}
          className="hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Cohorts
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{cohort.name}</h1>
          {cohort.description && (
            <p className="text-muted-foreground max-w-prose text-sm">{cohort.description}</p>
          )}
          <p className="text-muted-foreground text-xs">
            {cohort.memberCount} active {cohort.memberCount === 1 ? 'member' : 'members'} ·{' '}
            {cohort.roundCount} {cohort.roundCount === 1 ? 'round' : 'rounds'}
          </p>
        </div>
        <CohortHeaderActions demoClientId={id} cohort={cohort} />
      </header>

      <section className="space-y-3 rounded-md border px-4 py-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Roster</h2>
          <p className="text-muted-foreground text-xs">
            The people in this cohort. Removing a member revokes access without deleting their
            existing sessions; reactivate to restore access.
          </p>
        </div>
        <CohortMembersPanel cohortId={cohort.id} members={cohort.members} />
      </section>

      <section className="space-y-3 rounded-md border px-4 py-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Rounds</h2>
          <p className="text-muted-foreground text-xs">
            Time-bound deliveries of questionnaires to this cohort. Leave a new round&rsquo;s name
            blank to default it to the cohort name plus the window dates.
          </p>
        </div>
        <RoundsTable scope="cohort" demoClientId={id} cohortId={cohort.id} rounds={rounds} />
      </section>
    </div>
  );
}
