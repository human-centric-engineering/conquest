'use client';

/**
 * SectionEditor (F2.1 / PR2) — one editable, drag-sortable section with its
 * drag-sortable questions.
 *
 * Section title (on blur) and delete map to the section endpoints; the nested
 * DndContext reorders this section's questions via the question-reorder endpoint.
 * Adding a question POSTs under this section. All writes go through the parent's
 * `run` runner (fork notice + refetch handled centrally).
 */

import { useEffect, useState } from 'react';
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API } from '@/lib/api/endpoints';
import type { SectionView, TagView } from '@/lib/app/questionnaire/views';

import { QuestionEditor } from '@/components/admin/questionnaires/question-editor';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

export function SectionEditor({
  index,
  questionnaireId,
  versionId,
  section,
  allSections,
  tags,
  run,
  busy,
}: {
  /** Zero-based position, shown as a 1-based "01" plate number. */
  index: number;
  questionnaireId: string;
  versionId: string;
  section: SectionView;
  allSections: SectionView[];
  tags: TagView[];
  run: RunMutation;
  busy: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });
  const [title, setTitle] = useState(section.title);
  const [questions, setQuestions] = useState(section.questions);

  // Resync when the server graph changes (after a refetch).
  useEffect(() => setQuestions(section.questions), [section.questions]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sectionPath = API.APP.QUESTIONNAIRES.versionSectionById(
    questionnaireId,
    versionId,
    section.id
  );

  const saveTitle = () => {
    if (title.trim() && title !== section.title) void run(() => ['PATCH', sectionPath, { title }]);
  };

  const addQuestion = () => {
    void run(() => [
      'POST',
      API.APP.QUESTIONNAIRES.versionSectionQuestions(questionnaireId, versionId, section.id),
      // Start at the neutral midpoint of the 0.1–1.0 weight scale, leaving room to push
      // either way (the slider in the question row).
      { prompt: 'New question', type: 'free_text', weight: 0.5 },
    ]);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = questions.findIndex((q) => q.id === active.id);
    const newIndex = questions.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(questions, oldIndex, newIndex);
    setQuestions(reordered); // optimistic
    void run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionSectionQuestionsReorder(questionnaireId, versionId, section.id),
      { order: reordered.map((q) => q.id) },
    ]);
  };

  const plateNumber = String(index + 1).padStart(2, '0');

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`bg-card rounded-xl border shadow-sm ${isDragging ? 'opacity-60' : ''}`}
    >
      {/* Section plate header — drag handle, mono index, editable title, count, delete. */}
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <button
          type="button"
          className="text-muted-foreground/60 hover:text-foreground cursor-grab"
          aria-label="Drag to reorder section"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span
          className="flex h-7 min-w-7 items-center justify-center rounded-md border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-1.5 font-mono text-xs font-semibold text-[var(--cq-accent)]"
          aria-hidden
        >
          {plateNumber}
        </span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          disabled={busy}
          className="h-8 border-transparent bg-transparent text-base font-semibold tracking-tight shadow-none focus-visible:border-[var(--color-input)] focus-visible:bg-[var(--color-background)]"
          aria-label="Section title"
        />
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {questions.length} q{questions.length === 1 ? '' : 's'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={busy}
          aria-label="Delete section"
          onClick={() => void run(() => ['DELETE', sectionPath, undefined])}
        >
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>

      <div className="p-4">
        {questions.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm italic">
            No questions in this section yet.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={questions.map((q) => q.id)}
              strategy={verticalListSortingStrategy}
            >
              {/* Outline spine connecting the plate to its questions. */}
              <ul className="cq-spine ml-3 space-y-2.5 pl-4">
                {questions.map((q) => (
                  <QuestionEditor
                    key={q.id}
                    questionnaireId={questionnaireId}
                    versionId={versionId}
                    sections={allSections}
                    question={q}
                    tags={tags}
                    run={run}
                    busy={busy}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        <Button
          variant="outline"
          size="sm"
          className="mt-3 ml-7 text-xs"
          disabled={busy}
          onClick={addQuestion}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add question
        </Button>
      </div>
    </section>
  );
}
