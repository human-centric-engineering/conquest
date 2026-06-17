/**
 * TurnEvaluationReview component tests.
 *
 * Covers the human-review control surface for a persisted turn evaluation:
 * - Initial rendering with each flag status
 * - Comment field changes and save (PATCH call with correct payload)
 * - Flag transitions: none→flagged, flagged→reviewed, flagged/reviewed→none, any→dismissed
 * - `actioned` terminal/locked state (flag buttons hidden, everything locked)
 * - Dataset action panel: open, load datasets (GET call), select dataset, submit (POST call)
 * - Dataset load failure and action failure error handling
 * - Comment save failure error handling
 * - `onUpdated` callback fires after every successful mutation
 * - Disabled states during in-flight requests
 *
 * @see components/app/questionnaire/turn-evaluation/turn-evaluation-review.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TurnEvaluationReview } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-review';
import { apiClient } from '@/lib/api/client';

// Stub apiClient so no network hits occur.
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {},
}));

const mockPatch = vi.mocked(apiClient.patch);
const mockPost = vi.mocked(apiClient.post);
const mockGet = vi.mocked(apiClient.get);

const SESSION_ID = 'sess_abc123';
const EVAL_ID = 'eval_xyz789';

/** Build default props, merging overrides. */
function makeProps(
  overrides: Partial<Parameters<typeof TurnEvaluationReview>[0]> = {}
): Parameters<typeof TurnEvaluationReview>[0] {
  return {
    sessionId: SESSION_ID,
    evaluationId: EVAL_ID,
    initialFlagStatus: 'none',
    initialComment: null,
    onUpdated: vi.fn(),
    ...overrides,
  };
}

/** Helper: render the component and return a userEvent instance. */
function setup(overrides: Partial<Parameters<typeof TurnEvaluationReview>[0]> = {}) {
  const props = makeProps(overrides);
  const onUpdated = props.onUpdated as ReturnType<typeof vi.fn>;
  const user = userEvent.setup();
  const result = render(<TurnEvaluationReview {...props} />);
  return { ...result, user, onUpdated };
}

describe('TurnEvaluationReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all mutations succeed
    mockPatch.mockResolvedValue(undefined);
    mockPost.mockResolvedValue(undefined);
    mockGet.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  describe('initial rendering', () => {
    it('shows "Not flagged" status when initialFlagStatus is none', () => {
      setup({ initialFlagStatus: 'none' });
      expect(screen.getByText('Not flagged')).toBeInTheDocument();
    });

    it('shows "Flagged for learning" status when initialFlagStatus is flagged', () => {
      setup({ initialFlagStatus: 'flagged' });
      expect(screen.getByText('Flagged for learning')).toBeInTheDocument();
    });

    it('shows "Reviewed" status when initialFlagStatus is reviewed', () => {
      setup({ initialFlagStatus: 'reviewed' });
      expect(screen.getByText('Reviewed')).toBeInTheDocument();
    });

    it('shows "Actioned → dataset" status when initialFlagStatus is actioned', () => {
      setup({ initialFlagStatus: 'actioned' });
      expect(screen.getByText('Actioned → dataset')).toBeInTheDocument();
    });

    it('shows "Dismissed" status when initialFlagStatus is dismissed', () => {
      setup({ initialFlagStatus: 'dismissed' });
      expect(screen.getByText('Dismissed')).toBeInTheDocument();
    });

    it('pre-populates the comment textarea with initialComment', () => {
      setup({ initialComment: 'Great turn' });
      const textarea = screen.getByRole('textbox');
      expect((textarea as HTMLTextAreaElement).value).toBe('Great turn');
    });

    it('renders an empty textarea when initialComment is null', () => {
      setup({ initialComment: null });
      const textarea = screen.getByRole('textbox');
      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });

    it('renders a truncated datasetId next to the status when datasetId is provided', () => {
      setup({ initialFlagStatus: 'actioned', datasetId: 'abcdefgh-rest-of-id' });
      // The component slices to 8 chars and appends "…"
      expect(screen.getByText('(abcdefgh…)')).toBeInTheDocument();
    });

    it('does not render a dataset-id snippet when datasetId is absent', () => {
      setup({ initialFlagStatus: 'actioned', datasetId: null });
      expect(screen.queryByText(/…\)/)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Save comment
  // -------------------------------------------------------------------------
  describe('comment saving', () => {
    it('Save comment button is disabled when the comment is unchanged', () => {
      setup({ initialComment: 'hello' });
      const saveBtn = screen.getByRole('button', { name: /save comment/i });
      expect(saveBtn).toBeDisabled();
    });

    it('Save comment button becomes enabled after typing', async () => {
      const { user } = setup({ initialComment: '' });
      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'New note');
      const saveBtn = screen.getByRole('button', { name: /save comment/i });
      expect(saveBtn).not.toBeDisabled();
    });

    it('PATCHes the correct endpoint with the typed comment', async () => {
      const { user } = setup({ initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'Important observation');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));

      const [url, opts] = mockPatch.mock.calls[0];
      // Assert the endpoint is built from the correct sessionId + evaluationId
      expect(url).toContain(`/questionnaire-sessions/${SESSION_ID}/evaluations/${EVAL_ID}`);
      // Assert the body carries the typed comment (not the mock return value)
      expect((opts as { body: { comment: string } }).body.comment).toBe('Important observation');
    });

    it('calls onUpdated with the new comment after a successful save', async () => {
      const { user, onUpdated } = setup({ initialFlagStatus: 'flagged', initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'My note');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
      expect(onUpdated).toHaveBeenCalledWith({ flagStatus: 'flagged', comment: 'My note' });
    });

    it('trims the comment to null in onUpdated when the saved text is only whitespace', async () => {
      // The dirty check compares trimmed values, so we need a non-empty initialComment so
      // the transition from "   " (whitespace) to "" is actually dirty (saved was "x").
      // Then we clear and type spaces so comment.trim() is '' but savedComment.trim() was 'x' → dirty.
      const { user, onUpdated } = setup({ initialComment: 'x' });
      const textarea = screen.getByRole('textbox');
      // Clear the existing text then type whitespace so comment becomes "   " while saved is "x"
      await user.clear(textarea);
      await user.type(textarea, '   ');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
      // The component passes `comment.trim() || null` → null for whitespace-only
      expect(onUpdated).toHaveBeenCalledWith({ flagStatus: 'none', comment: null });
    });

    it('displays an error message when the PATCH fails', async () => {
      mockPatch.mockRejectedValue(new Error('Server unavailable'));
      const { user } = setup({ initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'some note');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      expect(await screen.findByText(/server unavailable/i)).toBeInTheDocument();
    });

    it('falls back to a default error message when the thrown value is not an Error', async () => {
      mockPatch.mockRejectedValue('string error');
      const { user } = setup({ initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'some note');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      expect(await screen.findByText(/could not save the comment/i)).toBeInTheDocument();
    });

    it('does not call onUpdated when the PATCH fails', async () => {
      mockPatch.mockRejectedValue(new Error('fail'));
      const { user, onUpdated } = setup({ initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'some note');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      // Give any async callback a chance to run
      await new Promise((r) => setTimeout(r, 0));
      expect(onUpdated).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Flag transitions
  // -------------------------------------------------------------------------
  describe('flag transitions', () => {
    it('shows "Flag for learning" button when status is none', () => {
      setup({ initialFlagStatus: 'none' });
      expect(screen.getByRole('button', { name: /flag for learning/i })).toBeInTheDocument();
    });

    it('shows "Flag for learning" button when status is dismissed', () => {
      setup({ initialFlagStatus: 'dismissed' });
      expect(screen.getByRole('button', { name: /flag for learning/i })).toBeInTheDocument();
    });

    it('none→flagged: PATCHes correct endpoint and payload, updates status label', async () => {
      const { user, onUpdated } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      await waitFor(() => expect(screen.getByText('Flagged for learning')).toBeInTheDocument());

      const [url, opts] = mockPatch.mock.calls[0];
      expect(url).toContain(`/questionnaire-sessions/${SESSION_ID}/evaluations/${EVAL_ID}`);
      expect((opts as { body: { flagStatus: string } }).body.flagStatus).toBe('flagged');

      expect(onUpdated).toHaveBeenCalledWith({ flagStatus: 'flagged', comment: null });
    });

    it('flagged→reviewed: shows "Mark reviewed" button and transitions status', async () => {
      const { user } = setup({ initialFlagStatus: 'flagged' });
      expect(screen.getByRole('button', { name: /mark reviewed/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /mark reviewed/i }));

      await waitFor(() => expect(screen.getByText('Reviewed')).toBeInTheDocument());
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringContaining(`/evaluations/${EVAL_ID}`),
        expect.objectContaining({ body: { flagStatus: 'reviewed' } })
      );
    });

    it('flagged→none (unflag): PATCHes with flagStatus none', async () => {
      const { user } = setup({ initialFlagStatus: 'flagged' });
      await user.click(screen.getByRole('button', { name: /unflag/i }));

      await waitFor(() => expect(screen.getByText('Not flagged')).toBeInTheDocument());
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: { flagStatus: 'none' } })
      );
    });

    it('reviewed→none (unflag): shows Unflag and transitions', async () => {
      const { user } = setup({ initialFlagStatus: 'reviewed' });
      expect(screen.getByRole('button', { name: /unflag/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /unflag/i }));
      await waitFor(() => expect(screen.getByText('Not flagged')).toBeInTheDocument());
    });

    it('none→dismissed: PATCHes with flagStatus dismissed', async () => {
      const { user } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      await waitFor(() => expect(screen.getByText('Dismissed')).toBeInTheDocument());
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: { flagStatus: 'dismissed' } })
      );
    });

    it('dismissed state hides "Dismiss" button but shows "Flag for learning"', () => {
      setup({ initialFlagStatus: 'dismissed' });
      expect(screen.getByRole('button', { name: /flag for learning/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it('calls onUpdated with new flag status after each transition', async () => {
      const { user, onUpdated } = setup({ initialFlagStatus: 'none', initialComment: 'hi' });
      mockPatch.mockResolvedValue(undefined);
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
      // savedComment is 'hi', trimmed and non-empty → passed through
      expect(onUpdated).toHaveBeenCalledWith({ flagStatus: 'flagged', comment: 'hi' });
    });

    it('displays an error message when a flag PATCH fails', async () => {
      mockPatch.mockRejectedValue(new Error('Flag update failed'));
      const { user } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      expect(await screen.findByText(/flag update failed/i)).toBeInTheDocument();
    });

    it('falls back to a default error message when flag PATCH throws a non-Error', async () => {
      mockPatch.mockRejectedValue(42);
      const { user } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      expect(await screen.findByText(/could not update the flag/i)).toBeInTheDocument();
    });

    it('does not update the displayed status label when the PATCH fails', async () => {
      mockPatch.mockRejectedValue(new Error('fail'));
      const { user } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      // The label should still read "Not flagged" because the PATCH failed
      expect(screen.getByText('Not flagged')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Actioned (terminal/locked) state
  // -------------------------------------------------------------------------
  describe('actioned (locked) state', () => {
    it('hides all flag-transition buttons when locked', () => {
      setup({ initialFlagStatus: 'actioned' });
      expect(screen.queryByRole('button', { name: /flag for learning/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /mark reviewed/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /unflag/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it('hides the dataset action panel button when locked', () => {
      setup({ initialFlagStatus: 'actioned' });
      expect(screen.queryByRole('button', { name: /send to dataset/i })).not.toBeInTheDocument();
    });

    it('still renders the comment textarea in locked state', () => {
      setup({ initialFlagStatus: 'actioned' });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Send to dataset / action-learning flow
  // -------------------------------------------------------------------------
  describe('send to dataset', () => {
    it('shows "Send to dataset…" button only when flagged or reviewed', () => {
      setup({ initialFlagStatus: 'flagged' });
      expect(screen.getByRole('button', { name: /send to dataset/i })).toBeInTheDocument();
    });

    it('does not show "Send to dataset…" when status is none', () => {
      setup({ initialFlagStatus: 'none' });
      expect(screen.queryByRole('button', { name: /send to dataset/i })).not.toBeInTheDocument();
    });

    it('opening the dataset panel calls GET on the eval-datasets endpoint', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));

      await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
      const [url] = mockGet.mock.calls[0];
      expect(url).toContain('/evaluations/datasets');
    });

    it('populates the dataset select with options returned by the GET', async () => {
      mockGet.mockResolvedValue([
        { id: 'ds1', name: 'Dataset Alpha' },
        { id: 'ds2', name: 'Dataset Beta' },
      ]);
      const { user } = setup({ initialFlagStatus: 'flagged' });
      await user.click(screen.getByRole('button', { name: /send to dataset/i }));

      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset Alpha' })).toBeInTheDocument()
      );
      expect(screen.getByRole('option', { name: 'Dataset Beta' })).toBeInTheDocument();
    });

    it('does not re-fetch datasets on second open if already loaded', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      // First open — loads datasets
      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

      // Close via Cancel
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      // Second open — should NOT re-fetch
      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('POSTs the action-learning endpoint with the selected datasetId', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );

      // Select the dataset
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');

      // Submit
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const [url, opts] = mockPost.mock.calls[0];
      expect(url).toContain(
        `/questionnaire-sessions/${SESSION_ID}/evaluations/${EVAL_ID}/action-learning`
      );
      expect((opts as { body: { datasetId: string } }).body.datasetId).toBe('ds1');
    });

    it('transitions to actioned status and hides the panel after a successful POST', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      await waitFor(() => expect(screen.getByText('Actioned → dataset')).toBeInTheDocument());
      // The action panel should be closed now
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('calls onUpdated with flagStatus "actioned" after successful POST', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user, onUpdated } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
      expect(onUpdated).toHaveBeenCalledWith({ flagStatus: 'actioned', comment: null });
    });

    it('"Append & action" button is disabled until a dataset is selected', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );

      // No dataset selected yet (default option value is "")
      expect(screen.getByRole('button', { name: /append.*action/i })).toBeDisabled();
    });

    it('does not POST when no dataset is selected', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );

      // Attempt submit without selecting
      const appendBtn = screen.getByRole('button', { name: /append.*action/i });
      expect(appendBtn).toBeDisabled();
      // If somehow the disabled check is bypassed, mockPost must not have fired
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('Cancel button closes the action panel without posting', async () => {
      mockGet.mockResolvedValue([]);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      // Panel is open
      expect(await screen.findByRole('combobox')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('shows an error when dataset GET fails', async () => {
      mockGet.mockRejectedValue(new Error('Dataset load error'));
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));

      expect(await screen.findByText(/dataset load error/i)).toBeInTheDocument();
    });

    it('falls back to default error message when dataset GET throws a non-Error', async () => {
      mockGet.mockRejectedValue(null);
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));

      expect(await screen.findByText(/could not load datasets/i)).toBeInTheDocument();
    });

    it('shows an error when the action POST fails', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      mockPost.mockRejectedValue(new Error('Action failed'));
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      expect(await screen.findByText(/action failed/i)).toBeInTheDocument();
    });

    it('does not transition to actioned if the action POST fails', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      mockPost.mockRejectedValue(new Error('fail'));
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      // Still flagged, not actioned
      expect(screen.getByText('Flagged for learning')).toBeInTheDocument();
    });

    it('falls back to default error message when action POST throws a non-Error', async () => {
      mockGet.mockResolvedValue([{ id: 'ds1', name: 'Dataset A' }]);
      mockPost.mockRejectedValue('string reason');
      const { user } = setup({ initialFlagStatus: 'flagged' });

      await user.click(screen.getByRole('button', { name: /send to dataset/i }));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Dataset A' })).toBeInTheDocument()
      );
      await user.selectOptions(screen.getByRole('combobox'), 'ds1');
      await user.click(screen.getByRole('button', { name: /append.*action/i }));

      expect(await screen.findByText(/could not append to the dataset/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Disabled/loading states
  // -------------------------------------------------------------------------
  describe('disabled and loading states', () => {
    it('Save comment button is disabled while a request is in-flight', async () => {
      // Hold the PATCH open so we can inspect the in-flight state
      let resolve!: (value: unknown) => void;
      mockPatch.mockReturnValue(
        new Promise((r) => {
          resolve = r;
        })
      );

      const { user } = setup({ initialComment: '' });
      await user.type(screen.getByRole('textbox'), 'note');
      await user.click(screen.getByRole('button', { name: /save comment/i }));

      // While the PATCH is pending, the button should be disabled
      expect(screen.getByRole('button', { name: /save comment/i })).toBeDisabled();

      resolve(undefined);
    });

    it('flag buttons are disabled while a flag request is in-flight', async () => {
      let resolve!: (value: unknown) => void;
      mockPatch.mockReturnValue(
        new Promise((r) => {
          resolve = r;
        })
      );

      const { user } = setup({ initialFlagStatus: 'none' });
      await user.click(screen.getByRole('button', { name: /flag for learning/i }));

      // The "Flag for learning" and "Dismiss" buttons should both be disabled
      expect(screen.getByRole('button', { name: /flag for learning/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeDisabled();

      resolve(undefined);
    });
  });
});
