/**
 * Diagnostics tab — per-invitation telemetry + error log for the selected version.
 *
 * Shares the workspace chrome (header, version selector, tabs) from the layout; reads `vid` from
 * the path and the date window from `searchParams`. Gated on the live-sessions flag (mirrors the
 * tab's visibility in `workspace-nav.ts`) — diagnostics is meaningless without respondent sessions.
 */
import type { Metadata } from 'next';

import { DiagnosticsView } from '@/components/admin/questionnaires/diagnostics/diagnostics-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getAnalyticsDefaultDateInputs } from '@/lib/app/questionnaire/analytics';
import type { VersionDiagnosticsResult } from '@/lib/app/questionnaire/analytics';

export const metadata: Metadata = {
  title: 'Diagnostics · Questionnaire',
  description: 'Per-invitation token use, response time, cost, and error log for a version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ from?: string; to?: string; roundId?: string }>;
}

function buildQuery(sp: { from?: string; to?: string; roundId?: string }): string {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.roundId) qs.set('roundId', sp.roundId);
  return qs.toString() ? `?${qs.toString()}` : '';
}

async function getDiagnostics(
  id: string,
  versionId: string,
  query: string
): Promise<VersionDiagnosticsResult | null> {
  try {
    const res = await serverFetch(
      `${API.APP.QUESTIONNAIRES.versionDiagnostics(id, versionId)}${query}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<VersionDiagnosticsResult>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('diagnostics tab: fetch failed', err);
    return null;
  }
}

export default async function DiagnosticsTab({ params, searchParams }: PageProps) {
  const { id, vid } = await params;
  const sp = await searchParams;

  const { from: defaultFrom, to: defaultTo } = getAnalyticsDefaultDateInputs();
  const filters = { from: sp.from || defaultFrom, to: sp.to || defaultTo };
  const data = await getDiagnostics(id, vid, buildQuery(sp));

  return <DiagnosticsView questionnaireId={id} versionId={vid} data={data} filters={filters} />;
}
