/**
 * Questionnaire entry point — redirects into the tabbed workspace.
 *
 * The detail surface moved to `/admin/questionnaires/[id]/v/[vid]/…`, where the
 * version is a path segment. This route stays as the canonical entry (the list,
 * the demo-client detail page, and clone all link here) and forwards to the
 * newest version's Overview. A `?v=` query — the shape old bookmarks used — is
 * honoured when present.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import {
  getQuestionnaireDetailCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

export const metadata: Metadata = {
  title: 'Questionnaire',
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

export default async function QuestionnaireEntryPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { v } = await searchParams;

  const [detail, flags] = await Promise.all([
    getQuestionnaireDetailCached(id),
    resolveQuestionnaireWorkspaceFlags(),
  ]);
  if (!flags.master) notFound();
  if (!detail) notFound();

  const target = detail.versions.find((ver) => ver.id === v)?.id ?? detail.versions[0]?.id ?? null;

  if (!target) {
    // A questionnaire with no versions is a degenerate state (ingestion always
    // creates v1). Show a minimal message rather than redirect to a dead URL.
    return (
      <div className="space-y-3">
        <h1 className="cq-display text-2xl font-semibold">{detail.title}</h1>
        <p className="text-muted-foreground text-sm italic">
          This questionnaire has no versions yet.
        </p>
      </div>
    );
  }

  redirect(workspaceVersionBase(id, target));
}
