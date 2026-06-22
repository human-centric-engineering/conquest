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
import { CohortSubgroupsPanel } from '@/components/admin/cohorts/cohort-subgroups-panel';
import { RoundsTable } from '@/components/admin/cohorts/rounds-table';
import { CompletionBar, SectionHeading } from '@/components/admin/cohorts/cohort-ui';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  isCohortsEnabled,
  isIntroScreenEnabled,
  isRoundPhasesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
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

  const [rounds, introScreenEnabled, roundPhasesEnabled] = await Promise.all([
    getCohortRounds(cohortId),
    isIntroScreenEnabled(),
    isRoundPhasesEnabled(),
  ]);

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
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{cohort.name}</h1>
          {cohort.description && (
            <p className="text-muted-foreground max-w-prose text-sm">{cohort.description}</p>
          )}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>
              <span className="text-foreground font-medium tabular-nums">{cohort.memberCount}</span>{' '}
              active {cohort.memberCount === 1 ? 'member' : 'members'}
            </span>
            <span aria-hidden>·</span>
            <span>
              <span className="text-foreground font-medium tabular-nums">{cohort.roundCount}</span>{' '}
              {cohort.roundCount === 1 ? 'round' : 'rounds'}
            </span>
            {cohort.stats.sessionsStarted > 0 && (
              <>
                <span aria-hidden>·</span>
                <CompletionBar
                  started={cohort.stats.sessionsStarted}
                  completed={cohort.stats.sessionsCompleted}
                  rate={cohort.stats.completionRate}
                  variant="full"
                />
              </>
            )}
          </div>
        </div>
        <CohortHeaderActions
          demoClientId={id}
          cohort={cohort}
          introScreenEnabled={introScreenEnabled}
        />
      </header>

      {roundPhasesEnabled && (
        <section className="space-y-3 rounded-xl border px-4 py-4">
          <SectionHeading title="Subgroups">
            Reusable partitions of this cohort&rsquo;s roster. A round can give each subgroup its
            own access window so one group (e.g. a leadership team) takes it before the rest. Assign
            members to a subgroup in the roster below.
          </SectionHeading>
          <CohortSubgroupsPanel cohortId={cohort.id} subgroups={cohort.subgroups} />
        </section>
      )}

      <section className="space-y-3 rounded-xl border px-4 py-4">
        <SectionHeading title="Roster">
          The people in this cohort. Removing a member revokes access without deleting their
          existing sessions; reactivate to restore access.
        </SectionHeading>
        <CohortMembersPanel
          cohortId={cohort.id}
          members={cohort.members}
          subgroups={roundPhasesEnabled ? cohort.subgroups : []}
        />
      </section>

      <section className="space-y-3 rounded-xl border px-4 py-4">
        <SectionHeading title="Rounds">
          Time-bound deliveries of questionnaires to this cohort. Leave a new round&rsquo;s name
          blank to default it to the cohort name plus the window dates.
        </SectionHeading>
        <RoundsTable scope="cohort" demoClientId={id} cohortId={cohort.id} rounds={rounds} />
      </section>
    </div>
  );
}
