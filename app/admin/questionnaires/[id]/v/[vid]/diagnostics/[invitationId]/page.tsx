/**
 * Diagnostics drill-down — one invitation.
 *
 * Lifecycle, per-turn telemetry, the captured error log, and the raw inspector deep-dive for a
 * single invitation. Shares the workspace chrome; gated on the live-sessions flag like the tab.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { InvitationDiagnosticsView } from '@/components/admin/questionnaires/diagnostics/invitation-diagnostics-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { InvitationDiagnosticsResult } from '@/lib/app/questionnaire/analytics';

export const metadata: Metadata = {
  title: 'Invitation diagnostics · Questionnaire',
  description: 'Lifecycle, per-turn telemetry, and error log for one invitation.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string; invitationId: string }>;
}

async function getInvitation(
  id: string,
  versionId: string,
  invitationId: string
): Promise<InvitationDiagnosticsResult | null> {
  try {
    const res = await serverFetch(
      API.APP.QUESTIONNAIRES.invitationDiagnostics(id, versionId, invitationId)
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<InvitationDiagnosticsResult>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('invitation diagnostics: fetch failed', err);
    return null;
  }
}

export default async function InvitationDiagnosticsPage({ params }: PageProps) {
  const { id, vid, invitationId } = await params;
  const data = await getInvitation(id, vid, invitationId);
  if (!data) notFound();

  return (
    <div className="space-y-4">
      <Link
        href={`/admin/questionnaires/${id}/v/${vid}/diagnostics`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" /> Back to diagnostics
      </Link>
      <InvitationDiagnosticsView data={data} />
    </div>
  );
}
