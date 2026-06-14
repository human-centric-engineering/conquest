'use client';

/**
 * VersionEditor (F2.1 / PR2) — the interactive authoring surface that replaces the
 * read-only `VersionGraph` when `?edit=1` is set.
 *
 * Orchestrates every structural mutation through one `run` runner: it calls the
 * authoring API, surfaces the server's error inline, applies the fork notice +
 * redirect when editing a launched version spawns a new draft, and `router
 * .refresh()`es to re-pull the SSR graph (refetch, not optimistic — except for the
 * drag reorder, which updates locally for responsiveness then refetches).
 *
 * Hydrated from the same `VersionGraphView` the detail page already fetched (no
 * second fetch). Structure only — goal/audience and run-time config live on the
 * Settings tab (they're version settings, not structure).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { PenLine, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { API } from '@/lib/api/endpoints';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';

import { SectionEditor } from '@/components/admin/questionnaires/section-editor';
import { TagVocabularyEditor } from '@/components/admin/questionnaires/tag-vocabulary-editor';
import { SaveStatus, type SaveState } from '@/components/admin/questionnaires/save-status';
import { authoringMutate } from '@/components/admin/questionnaires/authoring-mutate';
import type {
  MutationSpec,
  RunMutation,
} from '@/components/admin/questionnaires/version-editor-types';

/** Status transitions offered per current status (mirrors the API's legality). */
const STATUS_ACTIONS: Record<
  AppQuestionnaireStatus,
  { label: string; to: AppQuestionnaireStatus; variant: 'default' | 'outline' | 'destructive' }[]
> = {
  draft: [
    { label: 'Launch', to: 'launched', variant: 'default' },
    { label: 'Archive', to: 'archived', variant: 'outline' },
  ],
  launched: [
    { label: 'Un-launch', to: 'draft', variant: 'outline' },
    { label: 'Archive', to: 'archived', variant: 'destructive' },
  ],
  archived: [],
};

export function VersionEditor({
  questionnaireId,
  version,
}: {
  questionnaireId: string;
  version: VersionGraphView;
}) {
  const router = useRouter();
  const versionId = version.id;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<number | null>(null);

  // Autosave indicator: the editor has no Save button (every edit writes on its own),
  // so we surface the live state instead. `pendingSaveRef` distinguishes a real save
  // landing (flip to "saved") from the initial mount / unrelated refetches.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const pendingSaveRef = useRef(false);

  const [sections, setSections] = useState(version.sections);

  // Resync local state whenever the server graph changes (after a refetch), and
  // release the busy lock — `run` keeps the editor disabled until this fires, so
  // a forked edit can't re-fire against the now-stale `version.id`.
  useEffect(() => {
    setSections(version.sections);
    setBusy(false);
    // A pending write's refetch just landed → confirm it saved.
    if (pendingSaveRef.current) {
      pendingSaveRef.current = false;
      setSaveState('saved');
      setLastSavedAt(Date.now());
    }
  }, [version]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const run: RunMutation = (spec) => {
    const [method, path, body]: MutationSpec = spec();
    setBusy(true);
    setError(null);
    setSaveState('saving');
    pendingSaveRef.current = true;
    authoringMutate(method, path, body)
      .then(({ meta }) => {
        if (meta?.forked) {
          setForkNotice(meta.versionNumber);
          // Subsequent edits must target the new draft's Structure tab.
          router.replace(
            `/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/structure?edit=1`
          );
        }
        // Stay busy until the refreshed `version` prop arrives (the [version]
        // effect clears it + confirms the save) — this closes the window where a
        // second action could fire against the pre-fork version id and fork again.
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        pendingSaveRef.current = false;
        setSaveState('error');
        router.refresh(); // resync optimistic UI from the server
        setBusy(false);
      });
  };

  const setStatus = (to: AppQuestionnaireStatus) =>
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionStatus(questionnaireId, versionId),
      { status: to },
    ]);

  const addSection = () =>
    run(() => [
      'POST',
      API.APP.QUESTIONNAIRES.versionSections(questionnaireId, versionId),
      { title: 'New section' },
    ]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sections.findIndex((s) => s.id === active.id);
    const newIndex = sections.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(sections, oldIndex, newIndex);
    setSections(reordered); // optimistic
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionSectionsReorder(questionnaireId, versionId),
      { order: reordered.map((s) => s.id) },
    ]);
  };

  const questionCount = sections.reduce((n, s) => n + s.questions.length, 0);

  return (
    <div className="space-y-6">
      {/* Editing band — an architect's drafting sheet. Names the mode, explains the
          (otherwise invisible) autosave, and carries the status + lifecycle actions. */}
      <div className="cq-blueprint relative overflow-hidden rounded-xl border">
        <div className="bg-card/70 flex flex-wrap items-center gap-x-4 gap-y-3 p-4 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
              <PenLine className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight">Editing structure</p>
              <p className="text-muted-foreground text-xs">
                {sections.length} section{sections.length === 1 ? '' : 's'} · {questionCount}{' '}
                question{questionCount === 1 ? '' : 's'} · no Save button — every change saves
                itself
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <SaveStatus state={saveState} lastSavedAt={lastSavedAt} />
            <span className="bg-border h-6 w-px" aria-hidden />
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">
                Status <span className="text-foreground font-medium">{version.status}</span>
              </span>
              {STATUS_ACTIONS[version.status].map((a) => (
                <Button
                  key={a.to}
                  variant={a.variant}
                  size="sm"
                  disabled={busy}
                  onClick={() => setStatus(a.to)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {forkNotice !== null && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          You edited a launched version — your changes were saved to a new draft (v{forkNotice}).
          You are now editing that draft.
        </div>
      )}
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      )}

      {/* Goal/audience and run-time config live on the Settings tab (version settings, not
          structure). This editor is structure-only: tags + sections → questions. */}

      {/* Tag vocabulary */}
      <TagVocabularyEditor
        questionnaireId={questionnaireId}
        versionId={versionId}
        tags={version.tags}
        run={run}
        busy={busy}
      />

      {/* Sections → questions */}
      {sections.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm italic">
          No sections yet — add one to begin.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-5">
              {sections.map((section, i) => (
                <SectionEditor
                  key={section.id}
                  index={i}
                  questionnaireId={questionnaireId}
                  versionId={versionId}
                  section={section}
                  allSections={sections}
                  tags={version.tags}
                  run={run}
                  busy={busy}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <Button variant="outline" size="sm" disabled={busy} onClick={addSection}>
        <Plus className="mr-1 h-4 w-4" /> Add section
      </Button>

      {/* Always-visible autosave reassurance while scrolling a long structure. */}
      <SaveStatus state={saveState} lastSavedAt={lastSavedAt} variant="floating" />
    </div>
  );
}
