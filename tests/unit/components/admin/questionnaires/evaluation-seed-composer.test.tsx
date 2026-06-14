/**
 * Component test: EvaluationSeedComposer (F5.3 "Open in editor" refine path).
 *
 * Anti-green-bar: asserts the composer pre-fills the drafted question, creates it through the
 * authoring route on "Add to questionnaire", stamps the finding applied (against the forked draft
 * when the version forks), and navigates with the seed cleared — not merely that a mock returned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationSeedComposer } from '@/components/admin/questionnaires/evaluation-seed-composer';
import type { EvaluationSeed } from '@/lib/app/questionnaire/views';

const { mockReplace, mockRefresh } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockRefresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
}));

const { mockAuthoringMutate } = vi.hoisted(() => ({ mockAuthoringMutate: vi.fn() }));
vi.mock('@/components/admin/questionnaires/authoring-mutate', () => ({
  authoringMutate: mockAuthoringMutate,
}));

function seedOf(over: Partial<EvaluationSeed> = {}): EvaluationSeed {
  return {
    runId: 'run1',
    findingId: 'f1',
    prompt: 'How big is your team?',
    type: 'free_text',
    guidelines: 'Pick the closest band.',
    sectionKey: 'Background',
    ...over,
  };
}

const SECTIONS = [
  { id: 'sec-1', title: 'Background' },
  { id: 'sec-2', title: 'Goals' },
];

function renderComposer(seed = seedOf(), hasDataSlots = false) {
  return render(
    <EvaluationSeedComposer
      questionnaireId="qn1"
      versionId="v1"
      sections={SECTIONS}
      seed={seed}
      hasDataSlots={hasDataSlots}
    />
  );
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  mockAuthoringMutate.mockResolvedValue({ data: { id: 'new-q', key: 'team_size' }, meta: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('EvaluationSeedComposer', () => {
  it('pre-fills the drafted prompt and guidelines', () => {
    renderComposer();
    expect(screen.getByDisplayValue('How big is your team?')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Pick the closest band.')).toBeInTheDocument();
  });

  it('creates the question in the seeded section and marks the finding applied', async () => {
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    // Created through the authoring route, in the section matching the seed's title (sec-1).
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      '/api/v1/app/questionnaires/qn1/versions/v1/sections/sec-1/questions',
      expect.objectContaining({
        prompt: 'How big is your team?',
        type: 'free_text',
        guidelines: 'Pick the closest band.',
      })
    );

    // Finding stamped applied against the same (un-forked) version.
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ action: 'mark_applied', appliedToVersionId: 'v1' }),
        })
      )
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('marks the finding applied against the forked draft when the version forks', async () => {
    mockAuthoringMutate.mockResolvedValue({
      data: { id: 'new-q' },
      meta: { forked: true, versionId: 'v2', versionNumber: 2 },
    });
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/findings/f1'),
        expect.objectContaining({
          body: JSON.stringify({ action: 'mark_applied', appliedToVersionId: 'v2' }),
        })
      )
    );
    // Navigates to the new draft's editor with the seed cleared.
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/admin/questionnaires/qn1/v/v2/structure?edit=1',
        expect.objectContaining({ scroll: false })
      )
    );
  });

  it('surfaces an error and does not navigate when the create fails', async () => {
    mockAuthoringMutate.mockRejectedValue(new Error('Key already in use'));
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() => expect(screen.getByText('Key already in use')).toBeInTheDocument());
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('discards by clearing the seed deep-link without creating anything', async () => {
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(mockReplace).toHaveBeenCalledWith(
      '/admin/questionnaires/qn1/v/v1/structure?edit=1',
      expect.objectContaining({ scroll: false })
    );
    expect(mockAuthoringMutate).not.toHaveBeenCalled();
  });

  it('disables "Add to questionnaire" when the prompt is emptied', async () => {
    renderComposer();
    await userEvent.clear(screen.getByDisplayValue('How big is your team?'));
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeDisabled();
  });

  it('hides the data-slot checkbox when the version has no data slots', () => {
    renderComposer(seedOf(), false);
    expect(screen.queryByLabelText(/add to a data slot/i)).not.toBeInTheDocument();
  });

  it('assigns the new question to a data slot when the (pre-ticked) checkbox is on', async () => {
    renderComposer(seedOf(), true);
    // Pre-ticked by default.
    expect(screen.getByLabelText(/add to a data slot/i)).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn1/versions/v1/data-slots/assign',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ questionKeys: ['team_size'] }),
        })
      )
    );
  });

  it('does not assign when the checkbox is unticked', async () => {
    renderComposer(seedOf(), true);
    await userEvent.click(screen.getByLabelText(/add to a data slot/i)); // untick
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const calledAssign = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/data-slots/assign')
    );
    expect(calledAssign).toBe(false);
  });

  it('omits guidelines from the create body when the seed carries none', async () => {
    renderComposer(seedOf({ guidelines: null }));
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));
    const body = mockAuthoringMutate.mock.calls[0][2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('guidelines');
  });

  it('sends edited guidelines typed into the field', async () => {
    renderComposer(seedOf());
    const field = screen.getByLabelText(/author guidelines/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Probe for specifics.');
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));
    expect(mockAuthoringMutate.mock.calls[0][2]).toMatchObject({
      guidelines: 'Probe for specifics.',
    });
  });

  it('falls back to the first section when the seed sectionKey matches none', async () => {
    renderComposer(seedOf({ sectionKey: 'Nonexistent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));
    expect(mockAuthoringMutate).toHaveBeenCalledWith(
      'POST',
      '/api/v1/app/questionnaires/qn1/versions/v1/sections/sec-1/questions',
      expect.anything()
    );
  });

  it('still navigates when the best-effort mark_applied fetch rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('finding route down'));
    renderComposer(seedOf(), false);
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('still navigates when the best-effort data-slot assign fetch rejects', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) }) // mark_applied
      .mockRejectedValueOnce(new Error('assign down')); // assign
    renderComposer(seedOf(), true);
    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });
});
