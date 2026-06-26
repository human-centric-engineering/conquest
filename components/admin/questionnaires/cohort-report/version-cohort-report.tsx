'use client';

/**
 * VersionCohortReport — the version-mode client island around the owner-agnostic
 * {@link CohortReportPanel}.
 *
 * Mounts the shared panel with a version-scoped {@link ReportApi} and no version selector (a version
 * is a single scope, unlike a round that bundles several). Exists because the server tab page can't
 * build the api inline and hand it to a client component — the panel is `'use client'`.
 */

import { CohortReportPanel } from '@/components/admin/cohorts/cohort-report-panel';
import { versionReportApi } from '@/components/admin/cohorts/report-api';

export interface VersionCohortReportProps {
  questionnaireId: string;
  versionId: string;
}

export function VersionCohortReport({ questionnaireId, versionId }: VersionCohortReportProps) {
  const api = versionReportApi(questionnaireId, versionId);
  return <CohortReportPanel api={api} versionId={versionId} />;
}
