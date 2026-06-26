'use client';

/**
 * RoundCohortReportPanel — the round-mode adapter around the owner-agnostic {@link CohortReportPanel}.
 *
 * A round bundles several questionnaire versions, so this client wrapper owns the selected-version
 * state and rebuilds the round-scoped {@link ReportApi} for it (the report is per-version). Server
 * components can't pass functions across the RSC boundary, so the round detail page renders this thin
 * client wrapper rather than building the api itself.
 */

import * as React from 'react';

import { CohortReportPanel } from '@/components/admin/cohorts/cohort-report-panel';
import { roundReportApi } from '@/components/admin/cohorts/report-api';

export interface RoundCohortReportPanelProps {
  roundId: string;
  /** The round's bundled questionnaire versions (the analysis is per-version). */
  versions: Array<{ versionId: string; title: string }>;
}

export function RoundCohortReportPanel({ roundId, versions }: RoundCohortReportPanelProps) {
  const [versionId, setVersionId] = React.useState(versions[0]?.versionId ?? '');
  const api = React.useMemo(() => roundReportApi(roundId, versionId), [roundId, versionId]);

  return (
    <CohortReportPanel
      api={api}
      versions={versions}
      versionId={versionId}
      onVersionChange={setVersionId}
    />
  );
}
