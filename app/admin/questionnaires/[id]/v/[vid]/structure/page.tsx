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
import { DefinitionExportMenu } from '@/components/admin/questionnaires/definition-export-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ACCESS_MODE_LABELS } from '@/lib/app/questionnaire/types';
import {
  getEvaluationAddQuestionSeed,
  getQuestionnaireDetailCached,
  getVersionDataSlotCountCached,
  getVersionGraphCached,
} from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Structure · Questionnaire',
  description: 'View and edit a questionnaire version’s structure.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ edit?: string; seedFinding?: string }>;
}

export default async function StructureTab({ params, searchParams }: PageProps) {
  const { id, vid } = await params;
  const { edit, seedFinding } = await searchParams;

  const [detail, graph] = await Promise.all([
    getQuestionnaireDetailCached(id),
    getVersionGraphCached(id, vid),
  ]);
  if (!detail) notFound();

  const selected = detail.versions.find((ver) => ver.id === vid);
  if (!selected) notFound();

  // A design-evaluation "Open in editor" deep-link (?seedFinding=<runId>:<findingId>) pre-fills a
  // suggested question. Loading it forces edit mode so the composer is visible immediately.
  const seed =
    seedFinding && graph ? await getEvaluationAddQuestionSeed(id, vid, seedFinding) : null;
  const editing = (edit === '1' || seed !== null) && graph !== null;

  // When the version already has data slots, the seed composer offers to slot a newly-added
  // question (a question added afterwards would otherwise be orphaned from the slots).
  const hasDataSlots = editing ? (await getVersionDataSlotCountCached(id, vid)) > 0 : false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-sm">
            {selected.sectionCount} section{selected.sectionCount === 1 ? '' : 's'} ·{' '}
            {selected.questionCount} question{selected.questionCount === 1 ? '' : 's'} ·{' '}
            {selected.dataSlotCount} data slot{selected.dataSlotCount === 1 ? '' : 's'}
          </p>
          {graph && (
            <>
              {/* Access axis (who may start) and identity axis (whether responses are named) are
                  orthogonal — show them as two distinct badges. */}
              <Badge
                variant="outline"
                title={
                  graph.config.accessMode === 'public'
                    ? 'Public link: anyone with the URL can answer.'
                    : graph.config.accessMode === 'both'
                      ? 'Both: a public link and per-invitee links both work.'
                      : 'Invitation only: respondents need a per-invitee link.'
                }
              >
                {ACCESS_MODE_LABELS[graph.config.accessMode]}
              </Badge>
              <Badge
                variant={graph.config.anonymousMode ? 'secondary' : 'outline'}
                title={
                  graph.config.anonymousMode
                    ? 'Anonymous: responses are not tied to a named individual.'
                    : 'Identified: identifying profile fields are collected.'
                }
              >
                {graph.config.anonymousMode ? 'Anonymous' : 'Identified'}
              </Badge>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Export the definition + download the blank instrument (read-only; any status). */}
          {graph && <DefinitionExportMenu questionnaireId={id} versionId={selected.id} />}
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
          <VersionEditor
            questionnaireId={id}
            version={graph}
            seed={seed}
            hasDataSlots={hasDataSlots}
            designEvalEnabled={true}
            editAgentEnabled={true}
          />
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
