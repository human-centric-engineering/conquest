import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { ExperienceEmptyState } from '@/components/admin/experiences/experience-ui';
import { RunsTable } from '@/components/admin/experiences/runs-table';
import { getExperienceDetail } from '@/app/api/v1/app/experiences/_lib/read';
import { listRunsForExperience } from '@/app/api/v1/app/experiences/_lib/run-read';
import { Route } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Experience runs',
};

/**
 * Experience workspace — Runs tab.
 *
 * One respondent's journey per row, with what the router decided and why. The headline figures are
 * the ones an operator actually asks about: how many people took the journey, how many were routed
 * onward rather than concluded, and what it cost.
 */
export default async function ExperienceRunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [experience, runs] = await Promise.all([
    getExperienceDetail(id),
    listRunsForExperience(id),
  ]);
  if (!experience) notFound();

  const routed = runs.filter((r) => r.selectedStepKey !== null).length;
  const totalSpend = runs.reduce((sum, r) => sum + r.spentUsd, 0);
  const completed = runs.filter((r) => r.status === 'completed').length;

  const tiles: CqStat[] = [
    { label: 'Runs', value: runs.length },
    { label: 'Completed', value: completed, accent: true },
    {
      label: 'Routed onward',
      value: runs.length > 0 ? `${routed} / ${runs.length}` : '0',
      hint: 'Runs where the router chose a follow-up rather than concluding',
    },
    { label: 'Total spend', value: `$${totalSpend.toFixed(2)}` },
  ];

  if (runs.length === 0) {
    return (
      <div className="rounded-xl border">
        <ExperienceEmptyState
          icon={<Route className="h-5 w-5" />}
          title="No runs yet"
          body="Once someone starts this journey, each run appears here with the questionnaires they were routed through and the reasoning behind each decision."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CqStatTiles stats={tiles} />
      <RunsTable runs={runs} />
    </div>
  );
}
