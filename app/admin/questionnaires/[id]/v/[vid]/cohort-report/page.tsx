/**
 * Report tab — the version-wide **Cohort (synthesis) Report** (report kind `cohort`): an AI thematic
 * narrative, charts, recommendations and actions synthesised across ALL of this version's rounds plus
 * its open-ended sessions. The sibling Scoring tab configures it; this tab generates, edits, publishes
 * and exports it.
 *
 * Lives under the version segment for the shared workspace chrome (header + tabs). Gated behind the
 * combined `cohortReport` workspace flag (master AND cohorts AND cohort-report) — `notFound()`s when
 * off, mirroring the tab's visibility in `workspace-nav.ts`. Mounts the owner-agnostic
 * `CohortReportPanel` (via the version client island) with a version-scoped `ReportApi`.
 */
import type { Metadata } from 'next';

import { VersionCohortReport } from '@/components/admin/questionnaires/cohort-report/version-cohort-report';

export const metadata: Metadata = {
  title: 'Report · Questionnaire',
  description: 'A version-wide synthesis across all rounds and open-ended sessions.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

export default async function CohortReportTab({ params }: PageProps) {
  const { id, vid } = await params;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        A version-wide synthesis across all rounds and open-ended sessions. Generate the narrative,
        edit it, then publish or export it — privacy thresholds hide any group that is too small.
      </p>

      <VersionCohortReport questionnaireId={id} versionId={vid} />
    </div>
  );
}
