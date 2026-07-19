/**
 * SessionReportRerun component tests.
 *
 * The admin "re-run this session's report" dialog: edit the report settings/instructions, queue a
 * re-run against the real session, then view/promote any completed revision. Reads and writes the
 * re-run API directly via `apiClient`.
 *
 * Coverage targets:
 *  - trigger button shows the revision-count badge
 *  - opening the dialog reveals the re-run form + history, and the raw starting mode is normalised to
 *    an AI mode (re-run can't do raw)
 *  - submit POSTs config + note to reportRevisions, then refreshes (GET)
 *  - the KB-grounding toggle is gated on `hasClient`
 *  - a ready revision can be viewed (GET reportRevision → paper renderer) and promoted (POST
 *    reportRevisionPromote → refresh)
 *  - a submit failure surfaces the API error message
 *
 * @see components/admin/questionnaires/sessions/session-report-rerun.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: mockApiGet, post: mockApiPost },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

// Stub the shared paper renderer — it has its own tests; here we only assert the viewer reveals it.
vi.mock('@/components/app/questionnaire/report/report-body', () => ({
  ReportBody: ({ content }: { content: unknown }) => (
    <div data-testid="stub-report-body">{JSON.stringify(content)}</div>
  ),
  ReportPaperHeader: ({ title }: { title: string }) => (
    <div data-testid="stub-paper-header">{title}</div>
  ),
}));

import { SessionReportRerun } from '@/components/admin/questionnaires/sessions/session-report-rerun';
import { API } from '@/lib/api/endpoints';
import { REPORT_POLL_MS } from '@/components/admin/questionnaires/sessions/constants';
import { APIClientError } from '@/lib/api/client';
import { DEFAULT_RESPONDENT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';
import type {
  RespondentReportRevisionSummary,
  RespondentReportRevisionsView,
} from '@/lib/app/questionnaire/report/revision';

function revision(
  over: Partial<RespondentReportRevisionSummary> = {}
): RespondentReportRevisionSummary {
  return {
    id: 'rev-1',
    revisionNumber: 1,
    status: 'ready',
    authoredBy: 'admin',
    instructions: 'Warmer tone',
    mode: 'narrative',
    completionPct: 100,
    costUsd: 0.12,
    error: null,
    generatedAt: '2026-07-16T10:00:00.000Z',
    createdAt: '2026-07-16T09:59:00.000Z',
    delivered: false,
    ...over,
  };
}

function view(over: Partial<RespondentReportRevisionsView> = {}): RespondentReportRevisionsView {
  return {
    delivered: {
      status: 'ready',
      hasContent: true,
      generatedAt: '2026-07-16T09:00:00.000Z',
      deliveredRevisionId: null,
    },
    revisions: [],
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof SessionReportRerun>> = {}) {
  return render(
    <SessionReportRerun
      sessionId="sess-1"
      initialSettings={DEFAULT_RESPONDENT_REPORT_SETTINGS}
      initialView={view()}
      hasClient={false}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockResolvedValue(view());
  mockApiPost.mockResolvedValue({});
});

describe('SessionReportRerun', () => {
  it('shows the revision count badge on the trigger', () => {
    renderPanel({
      initialView: view({ revisions: [revision(), revision({ id: 'rev-2', revisionNumber: 2 })] }),
    });
    const trigger = screen.getByRole('button', { name: /re-run report/i });
    expect(within(trigger).getByText('2')).toBeInTheDocument();
  });

  it('opens the dialog and normalises a raw starting mode to narrative', async () => {
    const user = userEvent.setup();
    renderPanel({
      initialSettings: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS, mode: 'raw' },
    });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    // Dialog content is revealed; the mode combobox shows an AI mode, not "Raw answers only".
    expect(await screen.findByText('Respondent report re-runs')).toBeInTheDocument();
    expect(screen.getByText('Narrative report')).toBeInTheDocument();
    expect(screen.queryByText('Raw answers only')).not.toBeInTheDocument();
  });

  it('submits config + note to reportRevisions, then refreshes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    await user.type(screen.getByPlaceholderText(/warmer tone, added benchmarking/i), 'try v2');
    // The primary submit button inside the dialog body (distinct from the trigger).
    const submit = screen.getAllByRole('button', { name: /^re-run report$/i }).at(-1)!;
    await user.click(submit);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions('sess-1'),
        { body: { config: expect.objectContaining({ mode: 'narrative' }), instructions: 'try v2' } }
      );
    });
    // Refresh after enqueue.
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions('sess-1')
      );
    });
  });

  it('threads edited generation fields through into the submitted config', async () => {
    const user = userEvent.setup();
    renderPanel({ hasClient: true });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    // Edit each free-text generation field (exercises the per-field onChange → patchGen handlers).
    await user.type(screen.getByPlaceholderText(/warm and encouraging/i), 'Warm tone');
    await user.type(
      screen.getByPlaceholderText(/a short summary, then strengths/i),
      'Summary first'
    );
    await user.type(screen.getByPlaceholderText(/what the agent should know/i), 'Context blob');
    // Toggle both switches (discount-low-confidence defaults on → off; KB grounding off → on).
    await user.click(screen.getByLabelText(/discount low-confidence answers/i));
    await user.click(screen.getByLabelText(/ground in the client knowledge base/i));

    const submit = screen.getAllByRole('button', { name: /^re-run report$/i }).at(-1)!;
    await user.click(submit);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions('sess-1'),
        {
          body: {
            config: expect.objectContaining({
              mode: 'narrative',
              generation: expect.objectContaining({
                instructions: 'Warm tone',
                structure: 'Summary first',
                backgroundContext: 'Context blob',
                discountLowConfidence: false,
                useClientKnowledge: true,
              }),
            }),
            instructions: undefined,
          },
        }
      );
    });
  });

  it('surfaces the API error message when the re-run fails to enqueue', async () => {
    const user = userEvent.setup();
    mockApiPost.mockRejectedValueOnce(new APIClientError('Rate limit exceeded', 'RATE_LIMITED'));
    renderPanel();
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    const submit = screen.getAllByRole('button', { name: /^re-run report$/i }).at(-1)!;
    await user.click(submit);

    expect(await screen.findByText('Rate limit exceeded')).toBeInTheDocument();
  });

  it('hides the KB-grounding toggle when the questionnaire has no attributed client', async () => {
    const user = userEvent.setup();
    renderPanel({ hasClient: false });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));
    expect(screen.queryByText(/ground in the client knowledge base/i)).not.toBeInTheDocument();
  });

  it('shows the KB-grounding toggle when the questionnaire has an attributed client', async () => {
    const user = userEvent.setup();
    renderPanel({ hasClient: true });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));
    expect(screen.getByText(/ground in the client knowledge base/i)).toBeInTheDocument();
  });

  it('views a ready revision via reportRevision and renders the paper body', async () => {
    const user = userEvent.setup();
    mockApiGet.mockResolvedValueOnce({
      revisionNumber: 1,
      status: 'ready',
      mode: 'narrative',
      instructions: 'Warmer tone',
      content: { summary: 'the report' },
      formatted: true,
      completionPct: 100,
      error: null,
    });
    renderPanel({ initialView: view({ revisions: [revision()] }) });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    await user.click(await screen.findByRole('button', { name: /^view$/i }));

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevision('sess-1', 1)
      );
    });
    expect(await screen.findByTestId('stub-report-body')).toHaveTextContent('the report');
  });

  it('promotes a ready revision via reportRevisionPromote, then refreshes', async () => {
    const user = userEvent.setup();
    renderPanel({ initialView: view({ revisions: [revision()] }) });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    await user.click(await screen.findByRole('button', { name: /^promote$/i }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisionPromote('sess-1', 1)
      );
    });
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions('sess-1')
      );
    });
  });

  it('does not offer promote on an already-delivered revision', async () => {
    const user = userEvent.setup();
    renderPanel({ initialView: view({ revisions: [revision({ delivered: true })] }) });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));
    // The "Delivered" marker shows, but no Promote button for it.
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^promote$/i })).not.toBeInTheDocument();
  });

  it('renders the failure message (not the paper body) when a viewed revision is failed', async () => {
    const user = userEvent.setup();
    mockApiGet.mockResolvedValueOnce({
      revisionNumber: 1,
      status: 'failed',
      mode: 'narrative',
      instructions: null,
      content: null,
      formatted: false,
      completionPct: null,
      error: 'LLM timeout',
    });
    renderPanel({ initialView: view({ revisions: [revision()] }) });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    await user.click(await screen.findByRole('button', { name: /^view$/i }));

    expect(await screen.findByText(/this re-run failed: llm timeout/i)).toBeInTheDocument();
    expect(screen.queryByTestId('stub-report-body')).not.toBeInTheDocument();
  });

  it('shows the inline error and hides View/Promote for a failed revision row', async () => {
    const user = userEvent.setup();
    renderPanel({
      initialView: view({ revisions: [revision({ status: 'failed', error: 'no provider' })] }),
    });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));

    expect(await screen.findByText('no provider')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^view$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^promote$/i })).not.toBeInTheDocument();
  });

  it('tells the admin when the session has no delivered report yet', async () => {
    const user = userEvent.setup();
    renderPanel({ initialView: view({ delivered: null }) });
    await user.click(screen.getByRole('button', { name: /re-run report/i }));
    expect(await screen.findByText(/no delivered report yet/i)).toBeInTheDocument();
  });

  it('polls for status while a revision is in flight, then stops once it settles', async () => {
    vi.useFakeTimers();
    try {
      // Once the poll fires, the revision has settled to ready → inFlight flips false, polling stops.
      mockApiGet.mockResolvedValue(view({ revisions: [revision({ status: 'ready' })] }));

      renderPanel({ initialView: view({ revisions: [revision({ status: 'processing' })] }) });
      // fireEvent (not userEvent) — userEvent's internal delays deadlock against fake timers when
      // opening a Radix dialog. The Radix open-state flip renders the content synchronously.
      fireEvent.click(screen.getByRole('button', { name: /re-run report/i }));

      // Advance past one poll interval and the refresh GET fires (then the view settles ready).
      // Derived from the shared constant so retuning the interval doesn't silently break this test.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPORT_POLL_MS + 200);
      });
      expect(mockApiGet).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions('sess-1')
      );

      // After the view settles to ready, no further polls fire.
      const callsAfterSettle = mockApiGet.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 2);
      });
      expect(mockApiGet.mock.calls.length).toBe(callsAfterSettle);
    } finally {
      vi.useRealTimers();
    }
  });
});
