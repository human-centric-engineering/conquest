/**
 * Legacy redirect — data slots moved into the workspace at
 * `/admin/questionnaires/[id]/v/[vid]/data-slots`. Forwards `?v=` (or newest).
 */
import { notFound, redirect } from 'next/navigation';

import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

export default async function LegacyDataSlotsRedirect({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { v } = await searchParams;
  const detail = await getQuestionnaireDetailCached(id);
  if (!detail) notFound();
  const vid = detail.versions.find((ver) => ver.id === v)?.id ?? detail.versions[0]?.id;
  if (!vid) notFound();
  redirect(`${workspaceVersionBase(id, vid)}/data-slots`);
}
