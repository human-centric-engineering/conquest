/**
 * QuestionEditor — the likert editor must show/author endpoint anchor labels.
 *
 * Regression: an endpoint-anchored scale (the faithful shape for a source that anchors only its
 * ends, e.g. "1 — I dislike it … 5 — I love it") stores `minLabel`/`maxLabel` and no per-point
 * `labels`. The editor used to render only the per-point "Label for N" grid, so those scales
 * appeared as empty boxes even though the anchors were captured. This pins that the anchors render.
 *
 * Also covers the AUTHORING path (`BoundsEditor`'s `commit`): typing endpoint anchors and
 * blurring must PATCH a `typeConfig` carrying `minLabel`/`maxLabel` with no per-point `labels`
 * key — the write schema's other faithful labelling shape (see type-config-schema.ts).
 *
 * @see components/admin/questionnaires/question-editor.tsx (BoundsEditor)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { QuestionEditor } from '@/components/admin/questionnaires/question-editor';
import type { QuestionSlotView, SectionView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

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

function renderEditor(question: QuestionSlotView, run: RunMutation = vi.fn()) {
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
          run={run}
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

  it('authors minLabel/maxLabel as endpoint anchors and saves with per-point labels absent', () => {
    // Start from a bare, unlabelled 1–5 scale — no minLabel/maxLabel, no per-point labels typed
    // yet — so the save this test drives is purely the endpoint-anchor authoring path.
    const run = vi.fn();
    renderEditor(likertQuestion({ min: 1, max: 5 }), run);

    fireEvent.change(screen.getByPlaceholderText('e.g. Not at all'), {
      target: { value: 'Not at all' },
    });
    fireEvent.blur(screen.getByPlaceholderText('e.g. Not at all'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Very much'), {
      target: { value: 'Very much' },
    });
    fireEvent.blur(screen.getByPlaceholderText('e.g. Very much'));

    // `run` is the single mutation entry point (`RunMutation`): each commit calls it with a
    // thunk returning `[method, path, body]`. Invoke the LAST call's thunk to read the final
    // saved typeConfig, after both anchors have landed in local state.
    expect(run).toHaveBeenCalled();
    const lastSpec = run.mock.calls[run.mock.calls.length - 1]?.[0] as () => [
      string,
      string,
      unknown,
    ];
    const [method, , body] = lastSpec();

    expect(method).toBe('PATCH');
    // The mutual-exclusion contract: endpoint anchors are set, and — since no per-point label
    // was ever typed — the saved config carries no `labels` key at all (not even an empty one).
    expect(body).toEqual({
      typeConfig: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very much' },
    });
  });
});
