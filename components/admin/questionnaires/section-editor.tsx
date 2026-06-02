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
import type { SectionView } from '@/lib/app/questionnaire/views';

import { QuestionEditor } from '@/components/admin/questionnaires/question-editor';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

export function SectionEditor({
  questionnaireId,
  versionId,
  section,
  allSections,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  section: SectionView;
  allSections: SectionView[];
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
    if (title.trim() && title !== section.title) run(() => ['PATCH', sectionPath, { title }]);
  };

  const addQuestion = () =>
    run(() => [
      'POST',
      API.APP.QUESTIONNAIRES.versionSectionQuestions(questionnaireId, versionId, section.id),
      { prompt: 'New question', type: 'free_text' },
    ]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = questions.findIndex((q) => q.id === active.id);
    const newIndex = questions.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(questions, oldIndex, newIndex);
    setQuestions(reordered); // optimistic
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionSectionQuestionsReorder(questionnaireId, versionId, section.id),
      { order: reordered.map((q) => q.id) },
    ]);
  };

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`space-y-3 rounded-md border p-4 ${isDragging ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 border-b pb-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground cursor-grab"
          aria-label="Drag to reorder section"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          disabled={busy}
          className="h-8 font-medium"
          aria-label="Section title"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={busy}
          aria-label="Delete section"
          onClick={() => run(() => ['DELETE', sectionPath, undefined])}
        >
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>

      {questions.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">No questions in this section.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={questions.map((q) => q.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-2">
              {questions.map((q) => (
                <QuestionEditor
                  key={q.id}
                  questionnaireId={questionnaireId}
                  versionId={versionId}
                  sections={allSections}
                  question={q}
                  run={run}
                  busy={busy}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <Button variant="outline" size="sm" className="text-xs" disabled={busy} onClick={addQuestion}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add question
      </Button>
    </section>
  );
}
