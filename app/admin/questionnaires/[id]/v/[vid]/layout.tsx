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

import { BreadcrumbLabel } from '@/components/admin/breadcrumb-context';
import { QuestionnaireSubNav } from '@/components/admin/questionnaires/workspace/questionnaire-sub-nav';
import { VersionSelector } from '@/components/admin/questionnaires/workspace/version-selector';
import { PreviewRespondentButton } from '@/components/admin/questionnaires/workspace/preview-respondent-button';
import { QUESTIONNAIRE_STATUS_BADGE } from '@/components/admin/questionnaires/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  getQuestionnaireDetailCached,
  getVersionDataSlotCountCached,
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import { visibleWorkspaceTabs } from '@/lib/app/questionnaire/workspace-nav';
import { isPreviewAvailable } from '@/lib/app/questionnaire/launch/readiness';

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

  const [detail, flags, graph] = await Promise.all([
    getQuestionnaireDetailCached(id),
    resolveQuestionnaireWorkspaceFlags(),
    getVersionGraphCached(id, vid),
  ]);

  if (!flags.master) notFound();
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  const tabs = visibleWorkspaceTabs(flags);

  // "Preview as respondent" lives in the header so it's reachable from every tab (not just Overview).
  // Same availability rule as the Overview section + the server boot — shared `isPreviewAvailable`.
  // The graph + data-slot count are `cache()`d, so tabs that already load them pay nothing extra.
  const dataSlotCount = flags.dataSlots && graph ? await getVersionDataSlotCountCached(id, vid) : 0;
  const previewAvailable = isPreviewAvailable({
    status: selected.status,
    liveSessions: flags.liveSessions,
    graphPresent: graph !== null,
    ...(selected.status === 'draft' && graph
      ? {
          readiness: {
            goal: graph.goal,
            audience: graph.audience,
            sectionCount: selected.sectionCount,
            questionCount: selected.questionCount,
            configSaved: graph.config.saved,
            dataSlotsRequired: flags.dataSlots,
            dataSlotsReady: dataSlotCount > 0,
          },
        }
      : {}),
  });
  // The pill must describe what's actually on screen. A questionnaire-level "Launched"
  // badge next to the draft you're editing reads as a lie — so show the pill only when the
  // selected version IS the live one, and orient everything else with a subtitle that names
  // the live version. `versions` is newest-first, so the first launched one is the latest.
  const viewingLive = selected.status === 'launched';
  const liveBadge = QUESTIONNAIRE_STATUS_BADGE.launched;
  const latestLaunched = detail.versions.find((ver) => ver.status === 'launched') ?? null;

  return (
    <div className="space-y-6">
      {/* Make the top admin breadcrumb readable: title for the id, "vN" for the version. */}
      <BreadcrumbLabel segment={id} label={detail.title} />
      <BreadcrumbLabel segment={vid} label={`v${selected.versionNumber}`} />
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/questionnaires" className="hover:underline">
          Questionnaires
        </Link>
        {' / '}
        <span>{detail.title}</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 space-y-3 border-b px-6 pt-3 pb-0">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{detail.title}</h1>
            {viewingLive && <Badge variant={liveBadge.variant}>{liveBadge.label}</Badge>}
            <div className="ml-auto flex items-center gap-2">
              {previewAvailable && <PreviewRespondentButton versionId={selected.id} />}
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
          {!viewingLive && (
            <p className="text-muted-foreground mt-1 text-xs">
              You’re viewing v{selected.versionNumber} ({selected.status}) ·{' '}
              {latestLaunched
                ? `live version is v${latestLaunched.versionNumber}`
                : 'not yet launched'}
            </p>
          )}
        </div>
        <QuestionnaireSubNav questionnaireId={id} versionId={selected.id} tabs={tabs} />
      </header>

      {children}
    </div>
  );
}
