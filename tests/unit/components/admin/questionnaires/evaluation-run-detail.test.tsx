/**
 * Component test: the F5.3 review queue (`EvaluationRunDetail` + `FindingReviewCard`).
 *
 * Anti-green-bar: asserts the card calls the review/apply endpoints with the right method + body
 * (not merely that a mock returned), that Apply is disabled when a finding is stale or apply is
 * off, and that a successful action updates the card from the server response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationRunDetail } from '@/components/admin/questionnaires/evaluation-run-detail';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function finding(over: Partial<EvaluationFindingView> = {}): EvaluationFindingView {
  return {
    id: 'f1',
    dimension: 'duplicates',
    ordinal: 0,
    targetKey: 'q_dupe',
    target: null,
    severity: 'minor',
    proposedChange: 'Remove the duplicate question.',
    rationale: 'Same as q_role.',
    sourceQuote: null,
    status: 'pending',
    proposedEdit: { op: 'delete_question' },
    editedOverride: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'apply',
    ...over,
  };
}

function run(findings: EvaluationFindingView[]): EvaluationRunDetailView {
  return {
    id: 'run1',
    status: 'completed',
    dimensionsRequested: 7,
    dimensionsRun: 7,
    dimensionsFailed: 0,
    totalFindings: findings.length,
    dimensionSummary: [
      { dimension: 'duplicates', score: 0.8, findingCount: findings.length, diagnostic: null },
    ],
    triggeredByUserId: null,
    startedAt: '2026-06-05T00:00:00.000Z',
    completedAt: '2026-06-05T00:00:01.000Z',
    createdAt: '2026-06-05T00:00:01.000Z',
    versionId: 'v1',
    questionnaireId: 'qn1',
    error: null,
    findings,
  };
}

function renderQueue(
  findings: EvaluationFindingView[],
  canApply = true,
  dataSlotsAvailable = false
) {
  return render(
    <EvaluationRunDetail
      run={run(findings)}
      questionnaireId="qn1"
      versionId="v1"
      canApply={canApply}
      dataSlotsAvailable={dataSlotsAvailable}
    />
  );
}

function addQuestionFinding(over: Partial<EvaluationFindingView> = {}): EvaluationFindingView {
  // Keep dimension = 'duplicates' so it renders under the test run's single dimension summary.
  return finding({
    applicable: 'deep-link',
    proposedEdit: { op: 'add_question', prompt: 'How big is your team?', type: 'free_text' },
    ...over,
  });
}

function mockFetchOnce(data: unknown, meta?: unknown) {
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ success: true, data, meta }),
  });
}

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('EvaluationRunDetail review queue', () => {
  it('renders the finding with its proposed change and op summary', () => {
    renderQueue([finding()]);
    expect(screen.getByText('Remove the duplicate question.')).toBeInTheDocument();
    expect(screen.getByText('Delete this question')).toBeInTheDocument();
  });

  it('names the question a judgement is about, with its section and position', () => {
    renderQueue([
      finding({
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('“What is your role?”')).toBeInTheDocument();
    expect(screen.getByText('Question 2 · Background')).toBeInTheDocument();
  });

  it('marks a target that was removed from the structure since the run', () => {
    renderQueue([
      finding({
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 1,
          removed: true,
        },
      }),
    ]);
    expect(screen.getByText('· removed since this run')).toBeInTheDocument();
  });

  it('falls back to the raw key chip when the target could not be resolved', () => {
    renderQueue([finding({ target: null })]);
    expect(screen.getByText('q_dupe')).toBeInTheDocument();
    expect(screen.getByText('Target')).toBeInTheDocument();
  });

  it('labels a version-level goal finding without quoting it as a question', () => {
    renderQueue([
      finding({
        targetKey: 'goal',
        target: {
          kind: 'goal',
          key: 'goal',
          label: 'Questionnaire goal',
          sectionTitle: null,
          position: null,
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('Questionnaire goal')).toBeInTheDocument();
    expect(screen.getByText('Goal')).toBeInTheDocument();
  });

  it('accept calls the PATCH review endpoint with { action: "accept" } and updates the card', async () => {
    renderQueue([finding()]);
    mockFetchOnce(finding({ status: 'accepted' }));

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      })
    );
    await waitFor(() => expect(screen.getByText('Accepted')).toBeInTheDocument());
  });

  it('apply calls the apply endpoint and shows a fork banner when the response forks', async () => {
    renderQueue([finding()]);
    mockFetchOnce(
      { finding: finding({ status: 'applied', appliedToVersionId: 'v2' }) },
      {
        forked: true,
        versionId: 'v2',
        versionNumber: 2,
      }
    );

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1/apply',
      expect.objectContaining({ method: 'POST' })
    );
    await waitFor(() => expect(screen.getByText(/new draft/i)).toBeInTheDocument());
  });

  it('disables Apply when the finding is stale', () => {
    renderQueue([finding({ stale: true })]);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('disables Apply when apply is off (canApply=false)', () => {
    renderQueue([finding()], false);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('offers one-click "Add to questionnaire" + a seeded "Open in editor" link for an add_question', () => {
    renderQueue([
      finding({
        applicable: 'deep-link',
        proposedEdit: { op: 'add_question', prompt: 'How big is your team?', type: 'free_text' },
      }),
    ]);
    // Not the generic "Apply" — a question-specific primary action, plus the drafted prompt preview.
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeInTheDocument();
    expect(screen.getByText('How big is your team?')).toBeInTheDocument();
    // The editor link carries the finding ref so the editor can pre-fill the composer.
    const link = screen.getByRole('link', { name: /open in editor/i });
    expect(link.getAttribute('href')).toContain('seedFinding=run1%3Af1');
  });

  it('"Add to questionnaire" calls the apply endpoint and updates the card on success', async () => {
    renderQueue([
      finding({
        applicable: 'deep-link',
        proposedEdit: { op: 'add_question', prompt: 'New?', type: 'free_text' },
      }),
    ]);
    mockFetchOnce({ finding: finding({ status: 'applied', appliedToVersionId: 'v1' }) });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1/apply',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('omits Accept for an add_question (the work-actions imply it) but keeps Dismiss', () => {
    renderQueue([addQuestionFinding()]);
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    // Other op types still offer Accept (batch agree-then-apply).
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeInTheDocument();
  });

  it('disables "Add to questionnaire" when the add_question finding is stale', () => {
    renderQueue([
      finding({
        applicable: 'deep-link',
        stale: true,
        proposedEdit: { op: 'add_question', prompt: 'New?', type: 'free_text' },
      }),
    ]);
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeDisabled();
  });

  it('shows the data-slot checkbox for an add_question only when the version has data slots', () => {
    const { unmount } = renderQueue([addQuestionFinding()], true, false);
    expect(screen.queryByLabelText(/add to a data slot/i)).not.toBeInTheDocument();
    unmount();
    renderQueue([addQuestionFinding()], true, true);
    expect(screen.getByLabelText(/add to a data slot/i)).toBeChecked();
  });

  it('assigns the new question to a data slot after a one-click add when the checkbox is on', async () => {
    renderQueue([addQuestionFinding()], true, true);
    // Apply response (the finding, now applied to v1) then the follow-up assign call.
    mockFetchOnce({ finding: addQuestionFinding({ status: 'applied', appliedToVersionId: 'v1' }) });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { slots: [], assigned: 1, created: 0 } }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn1/versions/v1/data-slots/assign',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('does not assign after a one-click add when the data-slot checkbox is unticked', async () => {
    renderQueue([addQuestionFinding()], true, true);
    await userEvent.click(screen.getByLabelText(/add to a data slot/i)); // untick
    mockFetchOnce({ finding: addQuestionFinding({ status: 'applied', appliedToVersionId: 'v1' }) });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() => expect(screen.getByText(/Applied to/)).toBeInTheDocument());
    const calledAssign = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/data-slots/assign')
    );
    expect(calledAssign).toBe(false);
  });

  it('filters findings by status', async () => {
    renderQueue([
      finding({ id: 'f1', status: 'pending' }),
      finding({ id: 'f2', status: 'applied' }),
    ]);
    // Both visible under "all".
    expect(screen.getAllByText('Remove the duplicate question.')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'applied' }));
    await waitFor(() =>
      expect(screen.getAllByText('Remove the duplicate question.')).toHaveLength(1)
    );
  });

  it('dismiss calls PATCH with { action: "decline" }', async () => {
    renderQueue([finding()]);
    mockFetchOnce(finding({ status: 'declined' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'decline' }) })
    );
  });

  it('surfaces an error when the action fails', async () => {
    renderQueue([finding()]);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        success: false,
        error: { message: 'Boom', details: { reason: 'stale' } },
      }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.getByText(/Boom \(stale\)/)).toBeInTheDocument());
  });

  it('edit opens a typed form and saves an override via PATCH edit', async () => {
    renderQueue([finding({ proposedEdit: { op: 'replace_prompt', prompt: 'Old prompt' } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'New prompt');

    mockFetchOnce(finding({ editedOverride: { op: 'replace_prompt', prompt: 'New prompt' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          action: 'edit',
          editedOverride: { op: 'replace_prompt', prompt: 'New prompt' },
        }),
      })
    );
  });

  it('renders a change_type op summary and a type select in its edit form', async () => {
    renderQueue([finding({ proposedEdit: { op: 'change_type', type: 'single_choice' } })]);
    expect(screen.getByText(/Change answer type/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('dims a terminal (applied) finding and offers no actions', () => {
    renderQueue([finding({ status: 'applied', appliedToVersionId: 'v2' })]);
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.getByText(/Applied to/)).toBeInTheDocument();
  });

  it('renders a manual finding with an editor link and no Apply', () => {
    renderQueue([finding({ applicable: 'manual', proposedEdit: null })]);
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in editor/i })).toBeInTheDocument();
  });

  it('renders a failed dimension diagnostic instead of a score', () => {
    const r = run([]);
    r.dimensionSummary = [
      { dimension: 'duplicates', score: null, findingCount: 0, diagnostic: 'judge_not_configured' },
    ];
    render(<EvaluationRunDetail run={r} questionnaireId="qn1" versionId="v1" canApply />);
    expect(screen.getByText(/judge_not_configured/)).toBeInTheDocument();
  });

  it('shows "No issues raised" for a clean dimension', () => {
    render(<EvaluationRunDetail run={run([])} questionnaireId="qn1" versionId="v1" canApply />);
    expect(screen.getByText('No issues raised.')).toBeInTheDocument();
  });

  it('renders the source quote and a stale badge', () => {
    renderQueue([finding({ sourceQuote: 'the offending phrase', stale: true })]);
    expect(screen.getByText('the offending phrase')).toBeInTheDocument();
    expect(screen.getByText(/Stale — re-run/)).toBeInTheDocument();
  });

  it('marks an op as edited when an override is present', () => {
    renderQueue([
      finding({
        proposedEdit: { op: 'replace_prompt', prompt: 'a' },
        editedOverride: { op: 'delete_question' },
      }),
    ]);
    expect(screen.getByText(/· edited/)).toBeInTheDocument();
    // The effective op is the override (delete).
    expect(screen.getByText('Delete this question')).toBeInTheDocument();
  });

  it('describes edit_guidelines (set vs clear)', () => {
    const { unmount } = renderQueue([
      finding({ proposedEdit: { op: 'edit_guidelines', guidelines: 'Be concrete.' } }),
    ]);
    expect(screen.getByText('Set the author guidelines')).toBeInTheDocument();
    unmount();
    renderQueue([finding({ proposedEdit: { op: 'edit_guidelines', guidelines: null } })]);
    expect(screen.getByText('Clear the author guidelines')).toBeInTheDocument();
  });

  it('describes reorder with and without a target section', () => {
    const { unmount } = renderQueue([finding({ proposedEdit: { op: 'reorder', ordinal: 2 } })]);
    expect(screen.getByText('Move to position 3')).toBeInTheDocument();
    unmount();
    renderQueue([
      finding({ proposedEdit: { op: 'reorder', ordinal: 0, targetSectionKey: 'Intro' } }),
    ]);
    expect(screen.getByText(/Move to .*Intro.*position 1/)).toBeInTheDocument();
  });

  it('describes edit_audience and offers no inline Edit (not an inline-editable op)', () => {
    renderQueue([
      finding({
        targetKey: 'audience',
        proposedEdit: { op: 'edit_audience', audience: { role: 'x' } },
      }),
    ]);
    expect(screen.getByText(/Adjust audience \(role\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('saves an edited goal via the reorder/goal text form', async () => {
    renderQueue([
      finding({ targetKey: 'goal', proposedEdit: { op: 'edit_goal', goal: 'Old goal' } }),
    ]);
    expect(screen.getByText('Replace the questionnaire goal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Sharper goal');
    mockFetchOnce(finding());
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        body: JSON.stringify({
          action: 'edit',
          editedOverride: { op: 'edit_goal', goal: 'Sharper goal' },
        }),
      })
    );
  });

  it('edits a reorder ordinal via the number input', async () => {
    renderQueue([finding({ proposedEdit: { op: 'reorder', ordinal: 1 } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const numberInput = screen.getByRole('spinbutton');
    await userEvent.clear(numberInput);
    await userEvent.type(numberInput, '4');
    mockFetchOnce(finding());
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        body: JSON.stringify({ action: 'edit', editedOverride: { op: 'reorder', ordinal: 4 } }),
      })
    );
  });

  it('disables Save edit when the required text is emptied, and Cancel closes the form', async () => {
    renderQueue([finding({ proposedEdit: { op: 'replace_prompt', prompt: 'Some prompt' } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Save edit' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save edit' })).not.toBeInTheDocument();
  });
});
