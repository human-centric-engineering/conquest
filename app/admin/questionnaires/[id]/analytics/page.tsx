/**
 * Legacy redirect — analytics moved into the workspace at
 * `/admin/questionnaires/[id]/v/[vid]/analytics`. Forwards `?v=` (or the newest
 * version) and preserves the date/tag filter query.
 */
import { notFound, redirect } from 'next/navigation';

import { getQuestionnaireDetailCached } from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; from?: string; to?: string; tagIds?: string }>;
}

export default async function LegacyAnalyticsRedirect({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const detail = await getQuestionnaireDetailCached(id);
  if (!detail) notFound();
  const vid = detail.versions.find((ver) => ver.id === sp.v)?.id ?? detail.versions[0]?.id;
  if (!vid) notFound();

  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.tagIds) qs.set('tagIds', sp.tagIds);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';

  redirect(`${workspaceVersionBase(id, vid)}/analytics${suffix}`);
}
