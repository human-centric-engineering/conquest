/**
 * Overview tab — the workspace's default landing.
 *
 * A dashboard so admins land on a summary instead of the raw editor: status +
 * version stats, launch readiness (the same `<LaunchChecklist>` for drafts, a
 * launched confirmation otherwise), quick actions, and a version timeline. It
 * composes only data the workspace already fetches (`cache()` dedups detail +
 * graph) plus a flagged data-slot count — no new endpoints.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { LaunchChecklist } from '@/components/admin/questionnaires/launch-checklist';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  getQuestionnaireDetailCached,
  getVersionDataSlotCountCached,
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { isPreviewAvailable } from '@/lib/app/questionnaire/launch/readiness';

export const metadata: Metadata = {
  title: 'Overview · Questionnaire',
  description: 'Status, launch readiness, and a respondent preview for a questionnaire version.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

export default async function OverviewTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [detail, graph, flags] = await Promise.all([
    getQuestionnaireDetailCached(id),
    getVersionGraphCached(id, vid),
    resolveQuestionnaireWorkspaceFlags(),
  ]);
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  const dataSlotCount = flags.dataSlots ? await getVersionDataSlotCountCached(id, vid) : 0;

  const base = workspaceVersionBase(id, vid);
  const isDraft = selected.status === 'draft';
  const isLaunched = selected.status === 'launched';

  // Preview is available for a launched version OR a launchable draft (passes the same readiness
  // gate as launch — so an admin can rehearse before going live), and only when the live-sessions
  // surface is on. Shared with the workspace-header Preview button; the server
  // `createPreviewSession` enforces the same rule.
  const previewAvailable = isPreviewAvailable({
    status: selected.status,
    liveSessions: flags.liveSessions,
    graphPresent: graph !== null,
    ...(isDraft && graph
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

  const stats: CqStat[] = [
    { label: 'Sections', value: selected.sectionCount },
    // Data slots are the abstraction layer over the questions, so when the feature is on the two
    // counts share one tile: a single "Questions / Data slots" title over a "5 / 4" figure.
    flags.dataSlots
      ? {
          label: 'Questions / Data slots',
          value: (
            <span>
              <span className="text-[color:var(--cq-accent)]">{selected.questionCount}</span>
              <span className="text-muted-foreground/50"> / </span>
              <span>{selected.dataSlotCount}</span>
            </span>
          ),
        }
      : { label: 'Questions', value: selected.questionCount, accent: true },
    {
      label: 'Versions',
      value: detail.versions.length,
      hint: `viewing v${selected.versionNumber}`,
    },
    {
      label: 'Extraction changes',
      value: selected.changeCount,
      hint: selected.changeCount > 0 ? 'review on the Changes tab' : 'none recorded',
    },
  ];

  return (
    <div className="space-y-8">
      <CqStatTiles stats={stats} />

      {/* Launch readiness */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Launch readiness</h2>
        {isDraft && graph ? (
          <div className="bg-card rounded-xl border p-4">
            <LaunchChecklist
              questionnaireId={id}
              versionId={selected.id}
              versionNumber={selected.versionNumber}
              goal={graph.goal}
              audience={graph.audience}
              sectionCount={selected.sectionCount}
              questionCount={selected.questionCount}
              configSaved={graph.config.saved}
              dataSlotsRequired={flags.dataSlots}
              dataSlotsReady={dataSlotCount > 0}
            />
          </div>
        ) : isLaunched ? (
          <div className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="default">Launched</Badge>
              <span className="text-muted-foreground">
                This version is live. Manage respondents and review results below.
              </span>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/invitations`}>Invitations</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/analytics`}>Analytics</Link>
              </Button>
            </div>
          </div>
        ) : selected.status === 'archived' ? (
          <div className="bg-card rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              This version is <span className="text-foreground font-medium">archived</span>.
            </p>
          </div>
        ) : (
          // A draft whose structural graph failed to load lands here (status is draft, but
          // `graph` is null). Surface it as a load error with a retry — never as "archived",
          // which would misrepresent an editable draft as a terminal version.
          <div className="bg-card rounded-xl border p-4">
            <p className="text-foreground text-sm font-medium">Couldn’t load this version</p>
            <p className="text-muted-foreground mt-1 max-w-prose text-sm">
              We couldn’t load this version’s structure, so its launch readiness is unavailable.
              This is usually temporary — try reloading the page.
            </p>
          </div>
        )}
      </section>

      {/* Preview as respondent */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Preview as respondent</h2>
        <div className="bg-card rounded-xl border p-4">
          {previewAvailable ? (
            // Mirror the Launch readiness row exactly (gap-3, intro left, sm button top-right with
            // shrink-0) so the "Preview as respondent" button lines up with "Review & Launch".
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground min-w-0 text-sm">
                Walk through the questionnaire exactly as a respondent will. It opens in a new tab
                and isn&apos;t recorded in analytics
                {isDraft ? ' — you’re previewing this draft before launch.' : '.'}
              </p>
              {/* Always `?preview=1`: boots via the admin-gated `/preview` route, which marks the
                  run `isPreview` (kept out of analytics) and lets the surface show an exit link. */}
              <Button asChild size="sm" className="shrink-0">
                <Link href={`/q/${vid}?preview=1`} target="_blank" rel="noopener noreferrer">
                  Preview as respondent
                </Link>
              </Button>
            </div>
          ) : !flags.liveSessions ? (
            <p className="text-muted-foreground text-sm">
              Preview is unavailable while live respondent sessions are switched off.
            </p>
          ) : selected.status === 'archived' ? (
            <p className="text-muted-foreground text-sm">Archived versions can’t be previewed.</p>
          ) : isDraft && !graph ? (
            // Mirror the launch-readiness load-error state: the graph failed to load, so we can't
            // assess readiness or offer a preview. Don't tell them to "complete the checklist" —
            // it isn't shown.
            <p className="text-muted-foreground text-sm">
              Preview is unavailable because this version’s structure couldn’t be loaded. Try
              reloading the page.
            </p>
          ) : isDraft ? (
            <div className="space-y-1">
              <p className="text-foreground text-sm font-medium">Not available yet</p>
              <p className="text-muted-foreground max-w-prose text-sm">
                You can preview this draft before launching — as soon as it’s ready. Complete the
                launch checklist above
                {flags.dataSlots ? ', including confirming its data slots' : ''}; you don’t need to
                actually launch.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Preview is temporarily unavailable.</p>
          )}
        </div>
      </section>

      {/* Version timeline */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Versions</h2>
        <ul className="divide-y rounded-xl border">
          {detail.versions.map((ver) => {
            const active = ver.id === selected.id;
            return (
              <li
                key={ver.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <Link
                  href={workspaceVersionBase(id, ver.id)}
                  className={active ? 'font-medium' : 'hover:underline'}
                >
                  v{ver.versionNumber}
                  {active && <span className="text-muted-foreground ml-2 text-xs">(viewing)</span>}
                </Link>
                <div className="text-muted-foreground flex items-center gap-3 text-xs">
                  <span>
                    {ver.sectionCount} sections · {ver.questionCount} questions
                    {flags.dataSlots
                      ? ` · ${ver.dataSlotCount} data slot${ver.dataSlotCount === 1 ? '' : 's'}`
                      : ''}
                  </span>
                  <Badge variant="outline">{ver.status}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
