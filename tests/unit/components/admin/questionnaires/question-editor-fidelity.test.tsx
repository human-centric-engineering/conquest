// @vitest-environment happy-dom

/**
 * QuestionEditor — the per-question fidelity slider (P18).
 *
 * Pins the two things an admin depends on:
 *   1. the control shows the STOP NAME, not a bare number — "Must ask" is the decision they are
 *      making, and 1.0 tells them nothing;
 *   2. it stays visible (dimmed, with an explanation) while the version gate is off, so an admin
 *      preparing levels before switching over doesn't find the control missing and conclude the
 *      feature doesn't exist.
 *
 * @see components/admin/questionnaires/question-editor.tsx (FidelityControl)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { QuestionEditor } from '@/components/admin/questionnaires/question-editor';
import type { QuestionSlotView, SectionView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

function question(over: Partial<QuestionSlotView> = {}): QuestionSlotView {
  return {
    id: 'q-1',
    ordinal: 0,
    key: 'workload_satisfaction',
    prompt: 'How satisfied are you with your current workload?',
    guidelines: null,
    rationale: null,
    type: 'likert',
    typeConfig: { min: 1, max: 5 },
    required: true,
    weight: 0.5,
    fidelity: 0.5,
    extractionConfidence: null,
    tags: [],
    ...over,
  };
}

function renderEditor(q: QuestionSlotView, fidelityEnabled: boolean, run: RunMutation = vi.fn()) {
  const section: SectionView = {
    id: 's-1',
    ordinal: 0,
    title: 'Workload',
    description: null,
    questions: [q],
  };
  return render(
    <DndContext>
      <SortableContext items={[q.id]}>
        <QuestionEditor
          questionnaireId="qn-1"
          versionId="v-1"
          sections={[section]}
          question={q}
          tags={[]}
          fidelityEnabled={fidelityEnabled}
          run={run}
          busy={false}
        />
      </SortableContext>
    </DndContext>
  );
}

/** The Slider root carries the aria-label; Radix puts `role="slider"` on its thumb. */
const fidelityRoot = () => document.querySelector('[aria-label="Question fidelity"]');
/** The control's own wrapper, by its stable marker — not by DOM position or a Tailwind class. */
const fidelityWrapper = () => document.querySelector('[data-slot="fidelity-control"]');
/** The fidelity thumb specifically — the row also carries the Weight slider. */
const fidelityThumb = () => fidelityRoot()?.querySelector('[role="slider"]') as HTMLElement;

describe('QuestionEditor — fidelity slider', () => {
  it('names the stop rather than showing a raw number', () => {
    renderEditor(question({ fidelity: 1 }), true);
    expect(screen.getByText('Must ask')).toBeInTheDocument();
    // Radix puts `role="slider"` on the thumb and the aria-label on the root, so query them apart.
    expect(fidelityRoot()).not.toBeNull();
    expect(fidelityThumb()).not.toBeNull();
  });

  it('renders the correct name at every stop', () => {
    for (const [value, label] of [
      [0, 'Free'],
      [0.25, 'Loose'],
      [0.5, 'Balanced'],
      [0.75, 'Close'],
      [1, 'Must ask'],
    ] as const) {
      const { unmount } = renderEditor(question({ fidelity: value }), true);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('clamps an out-of-range stored value onto the grid instead of breaking', () => {
    // A hand-edited row or a bad import must not render a broken control.
    renderEditor(question({ fidelity: 9 }), true);
    expect(screen.getByText('Must ask')).toBeInTheDocument();
  });

  it('PATCHes the new stop when the admin moves the slider', async () => {
    // The write path. Radix drives the thumb from the keyboard, which fires the same
    // onValueChange → onValueCommit pair a drag does; a broken commit means the admin's setting
    // silently never saves.
    const run = vi.fn();
    renderEditor(question({ fidelity: 0.5 }), true, run);

    fidelityThumb().focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(run).toHaveBeenCalledTimes(1);
    const [, , body] = (run.mock.calls[0][0] as () => unknown[])();
    expect(body).toEqual({ fidelity: 0.75 });
  });

  it('does not PATCH again when the value lands back on the stored stop', async () => {
    // The guard compares against the STORED prop, not local state, so moving away and back must
    // produce exactly one write — not two. A no-op write is not harmless here: on a launched
    // version it would fork the whole questionnaire to change nothing.
    //
    // Note this has to actually commit twice. `focus()` alone never reaches the guard, so a test
    // that only focused would stay green with the guard deleted.
    const run = vi.fn();
    renderEditor(question({ fidelity: 0.5 }), true, run);

    fidelityThumb().focus();
    await userEvent.keyboard('{ArrowRight}'); // 0.5 → 0.75, differs from stored ⇒ saves
    await userEvent.keyboard('{ArrowLeft}'); // 0.75 → 0.5, back to stored ⇒ must NOT save

    expect(run).toHaveBeenCalledTimes(1);
    const [, , body] = (run.mock.calls[0][0] as () => unknown[])();
    expect(body).toEqual({ fidelity: 0.75 });
  });

  it('stays visible but dimmed when the version gate is off', () => {
    // Hiding it would leave an admin unable to prepare levels — and unable to discover the feature.
    renderEditor(question(), false);
    expect(fidelityThumb()).not.toBeNull();
    expect(fidelityWrapper()?.getAttribute('data-dimmed')).toBe('true');
  });

  it('is not dimmed once the gate is on', () => {
    renderEditor(question(), true);
    expect(fidelityWrapper()?.getAttribute('data-dimmed')).toBe('false');
  });
});
