/**
 * Legacy redirect — invitations moved into the workspace at
 * `/admin/questionnaires/[id]/v/[vid]/invitations`. Invitations are
 * questionnaire-scoped, so this forwards to the newest version's tab purely for
 * the shared chrome.
 */
import { notFound, redirect } from 'next/navigation';

import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacyInvitationsRedirect({ params }: PageProps) {
  const { id } = await params;
  const detail = await getQuestionnaireDetailCached(id);
  if (!detail) notFound();
  const vid = detail.versions[0]?.id;
  if (!vid) notFound();
  redirect(`${workspaceVersionBase(id, vid)}/invitations`);
}
