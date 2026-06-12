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

export const metadata: Metadata = {
  title: 'Overview · Questionnaire',
  description: 'Status, launch readiness, and quick actions for a questionnaire version.',
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

  const stats: CqStat[] = [
    { label: 'Sections', value: selected.sectionCount },
    { label: 'Questions', value: selected.questionCount, accent: true },
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
        <h2 className="cq-display text-lg font-semibold">Launch readiness</h2>
        {isDraft && graph ? (
          <div className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              This version is a <span className="text-foreground font-medium">draft</span>. Review
              the launch checklist before going live.
            </p>
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
            <p className="flex items-center gap-2 text-sm">
              <Badge variant="default">Launched</Badge>
              <span className="text-muted-foreground">
                This version is live. Manage respondents and review results below.
              </span>
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/invitations`}>Invitations</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/analytics`}>Analytics</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="bg-card rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              This version is <span className="text-foreground font-medium">archived</span>.
            </p>
          </div>
        )}
      </section>

      {/* Quick actions */}
      <section className="space-y-3">
        <h2 className="cq-display text-lg font-semibold">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="default" size="sm">
            <Link href={`${base}/structure?edit=1`}>Edit structure</Link>
          </Button>
          {flags.liveSessions && graph && isLaunched && (
            <Button asChild variant="outline" size="sm">
              <Link
                href={graph.config.anonymousMode ? `/q/${vid}` : `/q/${vid}?preview=1`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Preview as respondent
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/invitations`}>Invitations</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/analytics`}>Analytics</Link>
          </Button>
          {flags.dataSlots && (
            <Button asChild variant="outline" size="sm">
              <Link href={`${base}/data-slots`}>
                Data slots{dataSlotCount > 0 ? ` (${dataSlotCount})` : ''}
              </Link>
            </Button>
          )}
          {flags.designEval && (
            <Button asChild variant="outline" size="sm">
              <Link href={`${base}/evaluations`}>Evaluations</Link>
            </Button>
          )}
        </div>
      </section>

      {/* Version timeline */}
      <section className="space-y-3">
        <h2 className="cq-display text-lg font-semibold">Versions</h2>
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
