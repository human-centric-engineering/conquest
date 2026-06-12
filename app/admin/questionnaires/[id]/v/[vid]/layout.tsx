/**
 * Questionnaire **workspace** layout — the shared chrome for every version-scoped
 * tab (`/admin/questionnaires/[id]/v/[vid]/…`).
 *
 * Owns the three things every tab used to re-implement: the breadcrumb, the
 * sticky header (title + status + version selector), and the sub-navigation tab
 * bar. Resolves the questionnaire detail and feature flags once — `cache()` means
 * the child tab pages reuse the same detail fetch for free — and `notFound()`s
 * when the app flag is off, the questionnaire is missing, or the version id in
 * the URL doesn't exist.
 *
 * Why the version is a path segment (`/v/[vid]`) and not `?v=`: a layout can read
 * `params` but never `searchParams`, and this layout must render the version
 * selector and tab bar against the selected version. The path segment is the only
 * shape that lets the shared chrome live in the layout.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { QuestionnaireSubNav } from '@/components/admin/questionnaires/workspace/questionnaire-sub-nav';
import { VersionSelector } from '@/components/admin/questionnaires/workspace/version-selector';
import { QUESTIONNAIRE_STATUS_BADGE } from '@/components/admin/questionnaires/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  getQuestionnaireDetailCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import { visibleWorkspaceTabs } from '@/lib/app/questionnaire/workspace-nav';

export const metadata: Metadata = {
  title: 'Questionnaire',
  description: 'Author, launch, and analyse a questionnaire.',
};

interface LayoutProps {
  params: Promise<{ id: string; vid: string }>;
  children: React.ReactNode;
}

export default async function QuestionnaireWorkspaceLayout({ params, children }: LayoutProps) {
  const { id, vid } = await params;

  const [detail, flags] = await Promise.all([
    getQuestionnaireDetailCached(id),
    resolveQuestionnaireWorkspaceFlags(),
  ]);

  if (!flags.master) notFound();
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  const tabs = visibleWorkspaceTabs(flags);
  const statusBadge = QUESTIONNAIRE_STATUS_BADGE[detail.status];

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <span>{detail.title}</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 space-y-3 border-b px-6 pt-3 pb-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="cq-display text-2xl font-semibold">{detail.title}</h1>
          <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
          <div className="ml-auto">
            <VersionSelector
              questionnaireId={id}
              versionId={selected.id}
              versions={detail.versions.map((ver) => ({
                id: ver.id,
                versionNumber: ver.versionNumber,
                status: ver.status,
              }))}
            />
          </div>
        </div>
        <QuestionnaireSubNav questionnaireId={id} versionId={selected.id} tabs={tabs} />
      </header>

      {children}
    </div>
  );
}
