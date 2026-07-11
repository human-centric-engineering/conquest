/**
 * QuestionEditor — the likert editor must show/author endpoint anchor labels.
 *
 * Regression: an endpoint-anchored scale (the faithful shape for a source that anchors only its
 * ends, e.g. "1 — I dislike it … 5 — I love it") stores `minLabel`/`maxLabel` and no per-point
 * `labels`. The editor used to render only the per-point "Label for N" grid, so those scales
 * appeared as empty boxes even though the anchors were captured. This pins that the anchors render.
 *
 * @see components/admin/questionnaires/question-editor.tsx (BoundsEditor)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { QuestionEditor } from '@/components/admin/questionnaires/question-editor';
import type { QuestionSlotView, SectionView } from '@/lib/app/questionnaire/views';

function likertQuestion(typeConfig: unknown): QuestionSlotView {
  return {
    id: 'q-1',
    ordinal: 0,
    key: 'enjoyment_of_driving',
    prompt: 'How much do you genuinely enjoy the act of driving?',
    guidelines: null,
    rationale: null,
    type: 'likert',
    typeConfig,
    required: true,
    weight: 0.5,
    extractionConfidence: 0.8,
    tags: [],
  };
}

function renderEditor(question: QuestionSlotView) {
  const section: SectionView = {
    id: 's-1',
    ordinal: 0,
    title: 'Driving History & Passion',
    description: null,
    questions: [question],
  };
  return render(
    <DndContext>
      <SortableContext items={[question.id]}>
        <QuestionEditor
          questionnaireId="qn-1"
          versionId="v-1"
          sections={[section]}
          question={question}
          tags={[]}
          run={vi.fn()}
          busy={false}
        />
      </SortableContext>
    </DndContext>
  );
}

describe('QuestionEditor — likert endpoint anchors', () => {
  it('renders the stored minLabel/maxLabel in the endpoint inputs', () => {
    renderEditor(
      likertQuestion({
        min: 1,
        max: 5,
        minLabel: 'I dislike it / avoid it',
        maxLabel: 'I love it, driving is a pleasure in itself',
      })
    );
    // The endpoint anchors from the source are now visible + editable, not empty boxes.
    expect(screen.getByDisplayValue('I dislike it / avoid it')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('I love it, driving is a pleasure in itself')
    ).toBeInTheDocument();
  });

  it('still renders per-point labels when the scale is fully named', () => {
    renderEditor(
      likertQuestion({
        min: 1,
        max: 3,
        labels: ['Low', 'Mid', 'High'],
      })
    );
    expect(screen.getByDisplayValue('Low')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Mid')).toBeInTheDocument();
    expect(screen.getByDisplayValue('High')).toBeInTheDocument();
  });
});
