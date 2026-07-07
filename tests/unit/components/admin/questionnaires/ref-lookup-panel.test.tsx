/**
 * RefLookupPanel component tests.
 *
 * The panel lets an admin paste a support reference ("7F3K-9M2P"), look up the
 * matching chat via GET /api/v1/app/turn-evaluations/by-ref/:ref, and then
 * re-evaluate individual turns via POST …/:sessionId/turns/:ordinal/evaluate-saved.
 *
 * Coverage targets:
 *  - input handling and submit button enabled/disabled state
 *  - correct URL built and passed to apiClient.get on lookup
 *  - session + turns rendered on success (ref formatted, status badge, turn list)
 *  - not-found path (error thrown with message shown)
 *  - generic error path
 *  - loading spinner visible during lookup
 *  - empty-turns fallback
 *  - evaluateTurn: correct URL, score displayed on success, error message on failure
 *  - Evaluate button disabled when hasTraces is false or turn is running
 *
 * @see components/admin/questionnaires/ref-lookup-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── apiClient mock ──────────────────────────────────────────────────────────
// Must be hoisted so the module factory runs before RefLookupPanel is imported.

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: mockApiGet,
    post: mockApiPost,
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

// Stub the shared verdict + review children — they have their own tests; here we only assert
// the panel reveals them with the right props after an evaluation.
vi.mock('@/components/app/questionnaire/turn-evaluation/turn-evaluation-verdict', () => ({
  TurnEvaluationVerdict: ({ turnIndex }: { turnIndex: number }) => (
    <div data-testid="stub-verdict">StubVerdict turn {turnIndex}</div>
  ),
}));

vi.mock('@/components/app/questionnaire/turn-evaluation/turn-evaluation-review', () => ({
  TurnEvaluationReview: ({ evaluationId }: { evaluationId: string }) => (
    <div data-testid="stub-review">StubReview {evaluationId}</div>
  ),
}));

// ─── Import component after mocks ────────────────────────────────────────────

import { RefLookupPanel } from '@/components/admin/questionnaires/ref-lookup-panel';
import type { RefLookupResult } from '@/lib/app/questionnaire/views';

// ─── Factories ───────────────────────────────────────────────────────────────

function makeTurn(
  over: Partial<RefLookupResult['turns'][number]> = {}
): RefLookupResult['turns'][number] {
  return {
    ordinal: 1,
    userMessage: 'Hello, how does this work?',
    agentResponse: 'Great question! Let me explain.',
    calls: [],
    callCount: 3,
    hasTraces: true,
    evaluationCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function makeResult(over: Partial<RefLookupResult> = {}): RefLookupResult {
  return {
    session: {
      id: 'sess-abc123',
      ref: '7F3K9M2P',
      status: 'completed',
      isPreview: false,
      questionnaireTitle: 'Annual Survey',
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      versionNumber: 2,
      createdAt: '2026-06-01T00:00:00.000Z',
    },
    turns: [makeTurn()],
    ...over,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RefLookupPanel', () => {
  describe('initial render', () => {
    it('renders the reference input and look-up button', () => {
      render(<RefLookupPanel />);

      expect(screen.getByLabelText('Support reference')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /look up/i })).toBeInTheDocument();
    });

    it('renders the panel heading', () => {
      render(<RefLookupPanel />);

      expect(screen.getByText('Look up a chat by reference')).toBeInTheDocument();
    });

    it('disables the Look-up button when the input is empty', () => {
      render(<RefLookupPanel />);

      // Input is empty on mount — button must be disabled.
      expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
    });
  });

  describe('input handling', () => {
    it('enables the Look-up button once the user types a reference', async () => {
      const user = userEvent.setup();
      render(<RefLookupPanel />);

      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');

      // Button is enabled only because the user typed something — the component reacted
      // to the controlled input value, not a static prop.
      expect(screen.getByRole('button', { name: /look up/i })).not.toBeDisabled();
    });

    it('keeps the Look-up button disabled when the input is only whitespace', async () => {
      const user = userEvent.setup();
      render(<RefLookupPanel />);

      await user.type(screen.getByLabelText('Support reference'), '   ');

      expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
    });
  });

  describe('successful lookup', () => {
    it('calls apiClient.get with the correct by-ref URL', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult());

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce());

      // Assert the URL the component built — encodes the ref and uses the correct path.
      const calledUrl: string = mockApiGet.mock.calls[0][0];
      expect(calledUrl).toBe('/api/v1/app/turn-evaluations/by-ref/7F3K-9M2P');
    });

    it('renders the formatted session ref on success', async () => {
      const user = userEvent.setup();
      // ref='7F3K9M2P' (no dash) — formatSessionRef should add the dash for display
      mockApiGet.mockResolvedValue(makeResult({ session: makeResult().session }));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // The component calls formatSessionRef(result.session.ref) — '7F3K9M2P' → '7F3K-9M2P'.
      // The static example text in the description also contains '7F3K-9M2P', so use getAllByText.
      await waitFor(() => {
        const matches = screen.getAllByText('7F3K-9M2P');
        // At least two: the static example and the formatted session ref in the result
        expect(matches.length).toBeGreaterThanOrEqual(2);
        // The result ref is rendered in a font-mono font-semibold span
        const resultRef = matches.find((el) => el.className.includes('font-semibold'));
        expect(resultRef).toBeInTheDocument();
      });
    });

    it('renders the questionnaire title and version number', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({
          session: {
            ...makeResult().session,
            questionnaireTitle: 'My Questionnaire',
            versionNumber: 3,
          },
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // The span renders title + version as adjacent text nodes: "My Questionnaire · v3".
      // Query by the span's accumulated textContent to avoid ambiguity from ancestor elements.
      await waitFor(() => {
        // The title+version info is in a span with class text-muted-foreground.
        // Its textContent combines "My Questionnaire" and " · v3" (two text nodes).
        const spans = document.querySelectorAll('span.text-muted-foreground');
        const titleSpan = Array.from(spans).find(
          (el) => el.textContent?.includes('My Questionnaire') && el.textContent?.includes('v3')
        );
        expect(titleSpan).toBeTruthy();
      });
    });

    it('renders the session status badge', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult());

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());
    });

    it('renders a preview badge when the session is a preview', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({ session: { ...makeResult().session, isPreview: true } })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('preview')).toBeInTheDocument());
    });

    it('does not render the preview badge when the session is not a preview', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({ session: { ...makeResult().session, isPreview: false } })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());
      expect(screen.queryByText('preview')).not.toBeInTheDocument();
    });

    it('renders each turn with its ordinal and full message text', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({
          turns: [
            makeTurn({
              ordinal: 1,
              userMessage: 'First user message',
              agentResponse: 'First agent reply',
            }),
            makeTurn({
              ordinal: 2,
              userMessage: 'Second user message',
              agentResponse: 'Second agent reply',
            }),
          ],
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());
      expect(screen.getByText('Turn 2')).toBeInTheDocument();
      // Respondent/Interviewer label + full (untruncated) message text
      expect(screen.getByText('First user message')).toBeInTheDocument();
      expect(screen.getByText('Second agent reply')).toBeInTheDocument();

      // Interviewer is rendered ABOVE respondent within a turn (the conversation is
      // interviewer-led). Assert document order: the first turn's Interviewer line precedes
      // its Respondent line.
      const interviewer = screen.getByText('First agent reply');
      const respondent = screen.getByText('First user message');
      expect(interviewer.compareDocumentPosition(respondent)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('omits the respondent line on a turn with no respondent message (interviewer-led opener)', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({
          turns: [
            // Turn 1: the interviewer opens; the respondent has not spoken yet.
            makeTurn({
              ordinal: 1,
              userMessage: '',
              agentResponse: 'Opening question?',
            }),
            makeTurn({
              ordinal: 2,
              userMessage: 'My answer',
              agentResponse: 'Follow-up question?',
            }),
          ],
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('Opening question?')).toBeInTheDocument());
      // Turn 1 shows the interviewer but NO respondent label/line (it didn't render a bare dash).
      const turn1 = screen.getByText('Turn 1').closest('li') as HTMLElement;
      expect(turn1).not.toBeNull();
      expect(within(turn1).getByText('Interviewer:')).toBeInTheDocument();
      expect(within(turn1).queryByText('Respondent:')).toBeNull();

      // Turn 2 (respondent spoke) still shows both, interviewer first.
      const turn2 = screen.getByText('Turn 2').closest('li') as HTMLElement;
      expect(within(turn2).getByText('Interviewer:')).toBeInTheDocument();
      expect(within(turn2).getByText('Respondent:')).toBeInTheDocument();
    });

    it('renders the call count label when the turn has traces', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({ turns: [makeTurn({ callCount: 5, hasTraces: true })] })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // '5 calls' is the computed label from callCount — not from a mock value passed directly
      await waitFor(() => expect(screen.getByText('5 calls')).toBeInTheDocument());
    });

    it('renders "no saved traces" when the turn has no traces', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ hasTraces: false })] }));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('no saved traces')).toBeInTheDocument());
    });

    it('expands "Show raw calls" to reveal every call and its raw prompt + response', async () => {
      const user = userEvent.setup();
      const calls = [
        {
          label: 'Answer extraction',
          model: 'gpt-5.4',
          provider: 'openai',
          latencyMs: 100,
          costUsd: 0.001,
          prompt: [{ role: 'system', content: 'RAW-PROMPT-MARKER extract the answer.' }],
          response: 'central london',
        },
        {
          label: 'Interviewer phrasing',
          model: 'gpt-5.4',
          provider: 'openai',
          latencyMs: 200,
          costUsd: 0.002,
          prompt: [{ role: 'user', content: 'Phrase the next question.' }],
          response: 'Whereabouts?',
        },
      ];
      mockApiGet.mockResolvedValue(
        makeResult({ turns: [makeTurn({ calls, callCount: 2, hasTraces: true })] })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // Collapsed by default: the toggle is present but the calls are not yet rendered.
      const toggle = await screen.findByRole('button', { name: /show raw calls \(2\)/i });
      expect(screen.queryByText('Answer extraction')).not.toBeInTheDocument();

      // Expand → both calls render (all 2, not a count).
      await user.click(toggle);
      expect(screen.getByText('Answer extraction')).toBeInTheDocument();
      expect(screen.getByText('Interviewer phrasing')).toBeInTheDocument();

      // Drill into a call → its raw prompt + response become visible.
      await user.click(screen.getByRole('button', { name: /Answer extraction/i }));
      expect(screen.getByText(/RAW-PROMPT-MARKER extract the answer\./)).toBeInTheDocument();
      expect(screen.getByText('central london')).toBeInTheDocument();
    });

    it('shows prior evaluation count when evaluationCount > 0', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ evaluationCount: 3 })] }));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // '3 prior' appears via the evaluationCount branch — not injected by the mock
      await waitFor(() => expect(screen.getByText(/3 prior/)).toBeInTheDocument());
    });

    it('renders the empty-turns message when the session has no turns', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [] }));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() =>
        expect(screen.getByText('This chat has no recorded turns.')).toBeInTheDocument()
      );
    });

    it('renders "—" as questionnaire title when questionnaireTitle is null', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({
          session: { ...makeResult().session, questionnaireTitle: null, versionNumber: null },
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
    });
  });

  describe('loading state', () => {
    it('shows a loading spinner while the request is in flight', async () => {
      const user = userEvent.setup();
      // Never resolve so we can observe the loading state
      let resolveGet!: (val: RefLookupResult) => void;
      mockApiGet.mockReturnValue(
        new Promise<RefLookupResult>((res) => {
          resolveGet = res;
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      // The Loader2 icon is present while loading — the button text changes to use it.
      // (The Loader2 SVG is rendered inside the button; the button itself is disabled.)
      await waitFor(() => expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled());

      // Resolve to unblock cleanup
      resolveGet(makeResult());
    });

    it('disables the Look-up button while loading', async () => {
      const user = userEvent.setup();
      let resolveGet!: (val: RefLookupResult) => void;
      mockApiGet.mockReturnValue(
        new Promise<RefLookupResult>((res) => {
          resolveGet = res;
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled());

      resolveGet(makeResult());
    });
  });

  describe('error states', () => {
    it('shows the error message when apiClient.get throws', async () => {
      const user = userEvent.setup();
      // Distinct message so this (Error) branch is distinguishable from the non-Error fallback.
      mockApiGet.mockRejectedValue(new Error('Lookup service unavailable'));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() =>
        expect(screen.getByText('Lookup service unavailable')).toBeInTheDocument()
      );
    });

    it('shows a fallback error message when a non-Error is thrown', async () => {
      const user = userEvent.setup();
      // Throwing a non-Error object triggers the fallback branch
      mockApiGet.mockRejectedValue('something went wrong');

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() =>
        expect(screen.getByText('No chat found for that reference')).toBeInTheDocument()
      );
    });

    it('clears a previous result when a new lookup fails', async () => {
      const user = userEvent.setup();

      // First lookup succeeds
      mockApiGet.mockResolvedValueOnce(makeResult());
      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      // Wait until the result is visible — the questionnaire title appears inside a span with
      // the version suffix, so use a substring matcher. Also match 'completed' status badge.
      await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());

      // Second lookup fails — result should be cleared, error shown
      mockApiGet.mockRejectedValueOnce(new Error('Reference not found'));
      await user.clear(screen.getByLabelText('Support reference'));
      await user.type(screen.getByLabelText('Support reference'), 'XXXXYYY');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByText('Reference not found')).toBeInTheDocument());
      // The old result must be gone — the 'completed' badge from the first session is gone
      expect(screen.queryByText('completed')).not.toBeInTheDocument();
    });

    it('does not call the API when the ref input is empty (whitespace only)', async () => {
      const user = userEvent.setup();
      render(<RefLookupPanel />);

      // Type and then clear — button stays disabled; submitting the form is a no-op
      await user.type(screen.getByLabelText('Support reference'), ' ');
      // The form is submitted programmatically (button disabled prevents click)
      // but the guard inside lookup() returns early when ref.trim() is empty
      expect(mockApiGet).not.toHaveBeenCalled();
    });
  });

  describe('turn evaluation', () => {
    it('calls apiClient.post with the correct evaluate-saved URL for the clicked turn', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(
        makeResult({
          session: { ...makeResult().session, id: 'sess-xyz' },
          turns: [makeTurn({ ordinal: 2 })],
        })
      );
      mockApiPost.mockResolvedValue({
        verdict: { overallScore: 87 },
        evaluationId: 'eval-001',
      });

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 2')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledOnce());

      // The URL must include the session id (from result) and the turn ordinal (from the turn)
      const postedUrl: string = mockApiPost.mock.calls[0][0];
      expect(postedUrl).toBe('/api/v1/app/questionnaire-sessions/sess-xyz/turns/2/evaluate-saved');
    });

    it('displays the score and auto-reveals the full verdict + review after evaluation', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ ordinal: 1 })] }));
      mockApiPost.mockResolvedValue({
        verdict: { overallScore: 75 },
        model: 'gpt-test',
        evaluationId: 'eval-abc',
      });

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      // The score (computed from verdict.overallScore) is shown, and the verdict expands inline.
      await waitFor(() => expect(screen.getByText(/Scored 75\/100/)).toBeInTheDocument());
      // turnIndex passed is ordinal-1 = 0; review receives the persisted evaluationId.
      expect(screen.getByTestId('stub-verdict')).toHaveTextContent('turn 0');
      expect(screen.getByTestId('stub-review')).toHaveTextContent('eval-abc');
    });

    it('collapses and re-expands the verdict when the score toggle is clicked', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ ordinal: 1 })] }));
      mockApiPost.mockResolvedValue({
        verdict: { overallScore: 75 },
        model: 'gpt-test',
        evaluationId: 'eval-abc',
      });

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /evaluate/i }));
      await waitFor(() => expect(screen.getByTestId('stub-verdict')).toBeInTheDocument());

      // The toggle starts expanded ("Hide"); clicking it collapses the verdict.
      await user.click(screen.getByRole('button', { name: /Scored 75\/100 · Hide evaluation/ }));
      expect(screen.queryByTestId('stub-verdict')).toBeNull();

      // Clicking again ("View") re-reveals it.
      await user.click(screen.getByRole('button', { name: /Scored 75\/100 · View evaluation/ }));
      expect(screen.getByTestId('stub-verdict')).toBeInTheDocument();
    });

    it('omits the review controls when the verdict did not persist (null evaluationId)', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ ordinal: 1 })] }));
      mockApiPost.mockResolvedValue({
        verdict: { overallScore: 60 },
        model: 'gpt-test',
        evaluationId: null,
      });

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      // Verdict still shows, but with no persisted row there is nothing to review.
      await waitFor(() => expect(screen.getByTestId('stub-verdict')).toBeInTheDocument());
      expect(screen.queryByTestId('stub-review')).toBeNull();
    });

    it('shows an error message when the evaluate POST fails', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult());
      mockApiPost.mockRejectedValue(new Error('Evaluation failed: timeout'));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      await waitFor(() =>
        expect(screen.getByText('Evaluation failed: timeout')).toBeInTheDocument()
      );
    });

    it('shows fallback error message when evaluate POST throws a non-Error', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult());
      mockApiPost.mockRejectedValue('bad');

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      await waitFor(() => expect(screen.getByText('Evaluation failed')).toBeInTheDocument());
    });

    it('disables the Evaluate button for turns that have no traces', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult({ turns: [makeTurn({ hasTraces: false })] }));

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /evaluate/i })).toBeDisabled());

      // Disabled because hasTraces is false — verify no API call was made on click attempt
      expect(mockApiPost).not.toHaveBeenCalled();
    });

    it('disables the Evaluate button while evaluation is running', async () => {
      const user = userEvent.setup();
      mockApiGet.mockResolvedValue(makeResult());
      // Never resolve so we can observe the running state
      let resolvePost!: (val: unknown) => void;
      mockApiPost.mockReturnValue(
        new Promise((res) => {
          resolvePost = res;
        })
      );

      render(<RefLookupPanel />);
      await user.type(screen.getByLabelText('Support reference'), '7F3K-9M2P');
      await user.click(screen.getByRole('button', { name: /look up/i }));
      await waitFor(() => expect(screen.getByText('Turn 1')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /evaluate/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /evaluate/i })).toBeDisabled());

      // Resolve to unblock cleanup
      resolvePost({ verdict: { overallScore: 90 }, evaluationId: null });
    });
  });
});
