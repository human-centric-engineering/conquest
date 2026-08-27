// @vitest-environment happy-dom

/**
 * SectionEditor — the section-level "set fidelity" control (P18).
 *
 * Setting a seventy-question instrument one slider at a time is not a real workflow, and fidelity is
 * usually uniform within a section (a scored battery is all-or-nothing). This pins that the control
 * appears only when it can do something, and that it PATCHes the section-scoped bulk endpoint rather
 * than the whole version — the difference between setting one battery and silently rewriting every
 * question in the questionnaire.
 *
 * @see components/admin/questionnaires/section-editor.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { SectionEditor } from '@/components/admin/questionnaires/section-editor';
import type { QuestionSlotView, SectionView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

function question(id: string): QuestionSlotView {
  return {
    id,
    ordinal: 0,
    key: id,
    prompt: `Prompt ${id}?`,
    guidelines: null,
    rationale: null,
    type: 'likert',
    typeConfig: { min: 1, max: 5 },
    required: false,
    weight: 0.5,
    fidelity: 0.5,
    extractionConfidence: null,
    tags: [],
  };
}

function renderSection(opts: { fidelityEnabled: boolean; questions?: QuestionSlotView[] }) {
  const run: RunMutation = vi.fn();
  const section: SectionView = {
    id: 'sec-1',
    ordinal: 0,
    title: 'Workload',
    description: null,
    questions: opts.questions ?? [question('q1'), question('q2')],
  };
  render(
    <DndContext>
      <SortableContext items={[section.id]}>
        <SectionEditor
          index={0}
          questionnaireId="qn-1"
          versionId="v-1"
          section={section}
          allSections={[section]}
          tags={[]}
          fidelityEnabled={opts.fidelityEnabled}
          run={run}
          busy={false}
        />
      </SortableContext>
    </DndContext>
  );
  return { run };
}

const control = () =>
  screen.queryByRole('combobox', { name: /set fidelity for every question in this section/i });

describe('SectionEditor — bulk fidelity', () => {
  it('is hidden while the version gate is off', () => {
    renderSection({ fidelityEnabled: false });
    expect(control()).toBeNull();
  });

  it('is hidden for a section with no questions', () => {
    // Nothing to set — offering it would suggest an action with no effect.
    renderSection({ fidelityEnabled: true, questions: [] });
    expect(control()).toBeNull();
  });

  it('is offered once the gate is on and the section has questions', () => {
    renderSection({ fidelityEnabled: true });
    expect(control()).not.toBeNull();
  });

  it('PATCHes the bulk endpoint scoped to THIS section', async () => {
    // Omitting sectionId would set every question in the questionnaire — a destructive difference
    // the admin would not discover until they read the other sections back.
    const { run } = renderSection({ fidelityEnabled: true });

    await userEvent.click(control()!);
    await userEvent.click(await screen.findByRole('option', { name: 'Must ask' }));

    expect(run).toHaveBeenCalledTimes(1);
    const mutate = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => unknown[];
    const [method, path, body] = mutate();
    expect(method).toBe('PATCH');
    expect(path).toContain('/versions/v-1/questions');
    expect(body).toEqual({ fidelity: 1, sectionId: 'sec-1' });
  });

  it('sends the stop VALUE, not the level slug', async () => {
    // The API takes the numeric grid; sending 'close' would fail validation.
    const { run } = renderSection({ fidelityEnabled: true });

    await userEvent.click(control()!);
    await userEvent.click(await screen.findByRole('option', { name: 'Close' }));

    const mutate = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => unknown[];
    expect(mutate()[2]).toEqual({ fidelity: 0.75, sectionId: 'sec-1' });
  });
});
