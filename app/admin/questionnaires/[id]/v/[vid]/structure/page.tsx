/**
 * Structure tab — view / author the selected version's structure.
 *
 * This is the old questionnaire-detail editor, lifted into the workspace. The
 * shared layout supplies the header, version selector, and tab bar; this page
 * owns only the structure surface and its Edit/Done toggle (`?edit=1`, read here
 * because pages — unlike layouts — may read `searchParams`).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { VersionGraph } from '@/components/admin/questionnaires/version-graph';
import { VersionEditor } from '@/components/admin/questionnaires/version-editor';
import { ReingestDialog } from '@/components/admin/questionnaires/reingest-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  getQuestionnaireDetailCached,
  getVersionGraphCached,
  resolveQuestionnaireWorkspaceFlags,
} from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Structure · Questionnaire',
  description: 'View and edit a questionnaire version’s structure.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ edit?: string }>;
}

export default async function StructureTab({ params, searchParams }: PageProps) {
  const { id, vid } = await params;
  const { edit } = await searchParams;

  const [detail, graph] = await Promise.all([
    getQuestionnaireDetailCached(id),
    getVersionGraphCached(id, vid),
  ]);
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  const editing = edit === '1' && graph !== null;
  // Workspace flags (cached): `dataSlots` controls whether the header surfaces the data-slot count
  // beside the question count. (Run-time config — incl. the adaptive picker — lives on Settings.)
  const flags = await resolveQuestionnaireWorkspaceFlags();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-sm">
            {selected.sectionCount} section{selected.sectionCount === 1 ? '' : 's'} ·{' '}
            {selected.questionCount} question{selected.questionCount === 1 ? '' : 's'}
            {flags.dataSlots
              ? ` · ${selected.dataSlotCount} data slot${selected.dataSlotCount === 1 ? '' : 's'}`
              : ''}
          </p>
          {graph && (
            <Badge
              variant={graph.config.anonymousMode ? 'secondary' : 'outline'}
              title={
                graph.config.anonymousMode
                  ? 'Anonymous mode: anyone with the link can answer without an account.'
                  : 'Invitation only: respondents need an invitation. Preview opens an admin-only walkthrough.'
              }
            >
              {graph.config.anonymousMode ? 'Anonymous mode' : 'Invitation only'}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Re-ingest is a draft editorial operation (F2.4) — only offered on drafts. */}
          {selected.status === 'draft' && (
            <ReingestDialog
              questionnaireId={id}
              versionId={selected.id}
              versionNumber={selected.versionNumber}
            />
          )}
          {graph && (
            <Button asChild variant={editing ? 'outline' : 'default'} size="sm">
              <Link
                href={`/admin/questionnaires/${id}/v/${selected.id}/structure${editing ? '' : '?edit=1'}`}
                scroll={false}
              >
                {editing ? 'Done' : 'Edit'}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {graph ? (
        editing ? (
          <VersionEditor questionnaireId={id} version={graph} />
        ) : (
          <VersionGraph graph={graph} />
        )
      ) : (
        <p className="text-muted-foreground text-sm italic">
          Could not load this version’s structure.
        </p>
      )}
    </div>
  );
}
