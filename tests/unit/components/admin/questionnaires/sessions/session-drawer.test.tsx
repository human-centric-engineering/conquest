/**
 * SessionDrawer component tests.
 *
 * The alpha Sessions console slide-over: one `/admin-view` fetch seeds three tabs (Transcript /
 * Report / Evaluations). This isolates the drawer's OWN orchestration — the fetch lifecycle, the
 * open/close reset, the error + retry path, the Report tab's availability gating, the method panel,
 * and the poll that runs while a report generates. Every heavy child surface is mocked; they have
 * their own tests.
 *
 * @see components/admin/questionnaires/sessions/session-drawer.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionDrawer } from '@/components/admin/questionnaires/sessions/session-drawer';
import { apiClient, APIClientError } from '@/lib/api/client';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

vi.mock('@/lib/api/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

// Child surfaces — each has its own test; mocking them keeps this focused on the drawer.
vi.mock('@/components/app/questionnaire/session-workspace', () => ({
  SessionWorkspace: ({ initialTurns }: { initialTurns: unknown[] }) => (
    <div data-testid="workspace">turns: {initialTurns.length}</div>
  ),
}));
vi.mock('@/components/admin/questionnaires/sessions/session-report-rerun', () => ({
  SessionReportRerun: () => <div data-testid="report-rerun" />,
}));
vi.mock('@/components/admin/questionnaires/sessions/session-downloads', () => ({
  SessionDownloads: () => <div data-testid="downloads" />,
}));
vi.mock('@/components/admin/questionnaires/ref-lookup-panel', () => ({
  RefLookupPanel: () => <div data-testid="ref-lookup" />,
}));
vi.mock('@/components/app/questionnaire/turn-evaluation/turn-evaluation-verdict', () => ({
  TurnEvaluationVerdict: () => <div data-testid="verdict" />,
}));
vi.mock('@/components/app/questionnaire/turn-evaluation/turn-evaluation-review', () => ({
  TurnEvaluationReview: () => <div data-testid="review" />,
}));

const mockGet = vi.mocked(apiClient.get);
const mockPost = vi.mocked(apiClient.post);

function item(over: Partial<AdminSessionRefItem> = {}): AdminSessionRefItem {
  return {
    sessionId: 'sess-1',
    ref: '7F3K9M2P',
    refFormatted: '7F3K-9M2P',
    status: 'completed',
    isPreview: false,
    createdAt: '2026-07-16T10:00:00.000Z',
    questionnaireId: 'q-1',
    questionnaireTitle: 'Onboarding',
    versionId: 'v-1',
    versionNumber: 3,
    clientId: 'dc-1',
    clientName: 'Acme',
    roundId: 'r-1',
    roundName: 'Q3 Leadership',
    cohortId: 'c-1',
    cohortName: 'Leadership Team',
    turns: 4,
    answeredCount: 6,
    totalQuestions: 10,
    percentComplete: 60,
    durationMs: 23 * 60 * 1000,
    activeMs: 23 * 60 * 1000,
    sittings: 1,
    ...over,
  };
}

/** The `/admin-view` payload, defaulting to a completed session with a ready report. */
function adminView(over: Record<string, unknown> = {}) {
  return {
    turns: [{ id: 't1' }, { id: 't2' }],
    reportPanel: {
      settings: {},
      hasClient: true,
      initialView: { delivered: null, revisions: [] },
    },
    report: {
      insights: { status: 'ready', content: { summary: 'S', sections: [], actions: [] } },
    },
    method: null,
    availability: { state: 'exists', message: '' },
    evaluations: [],
    ...over,
  };
}

/** The admin projection of a method record, as `buildReportMethodView(..., 'admin')` returns it. */
function methodView() {
  return {
    summary: 'We read all 6 of your answers.',
    preview: false,
    facts: [{ key: 'answers', label: 'Your answers', value: 'All 6' }],
    sources: [],
    checks: ['Less certain answers were given proportionally less weight.'],
    admin: {
      model: { provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' },
      costUsd: 0.04,
      durationMs: 2500,
      searches: [],
      documents: [],
      stages: [{ key: 'answers', ran: true }],
      summarySource: 'agent' as const,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(adminView());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionDrawer — fetch lifecycle', () => {
  it('fetches the admin view when opened and renders the header', async () => {
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('7F3K-9M2P')).toBeInTheDocument();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toContain('sess-1');
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('· 60% complete')).toBeInTheDocument();
  });

  it('does not fetch while closed', () => {
    render(<SessionDrawer item={item()} open={false} onOpenChange={() => {}} />);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows a loading state before the payload lands', async () => {
    let resolve!: (v: unknown) => void;
    mockGet.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    expect(screen.getByText(/Loading session/i)).toBeInTheDocument();

    await act(async () => resolve(adminView()));
    await waitFor(() => expect(screen.queryByText(/Loading session/i)).not.toBeInTheDocument());
  });

  it('surfaces the API message on failure and refetches on Retry', async () => {
    mockGet.mockRejectedValueOnce(new APIClientError('Session not found'));
    const user = userEvent.setup();
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText('Session not found')).toBeInTheDocument());

    mockGet.mockResolvedValue(adminView());
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByTestId('workspace')).toBeInTheDocument());
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic message for a non-API error', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Could not load this session/i)).toBeInTheDocument()
    );
  });

  it('never flashes the previous session while the next one loads', async () => {
    // Reopening on a different session must show the loading state, never the previous transcript.
    // Two mechanisms enforce it redundantly (the load path nulls the payload, and `loading` gates the
    // render), so removing either alone is still correct — this pins the user-visible outcome rather
    // than one implementation detail.
    //
    // Note the assertion is deliberately made mid-load: asserting after a *close* would be vacuous,
    // since Radix unmounts the portal and leaves the DOM empty whatever the state says.
    const { rerender } = render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('workspace')).toHaveTextContent('turns: 2'));

    let resolve!: (v: unknown) => void;
    mockGet.mockReturnValue(new Promise((r) => (resolve = r)));
    rerender(<SessionDrawer item={item({ sessionId: 'sess-2' })} open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Loading session/i)).toBeInTheDocument());
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();

    await act(async () => resolve(adminView({ turns: [{ id: 'x' }] })));
    await waitFor(() => expect(screen.getByTestId('workspace')).toHaveTextContent('turns: 1'));
  });

  it('refetches when the drawer is reopened on a different session', async () => {
    const { rerender } = render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    rerender(<SessionDrawer item={item({ sessionId: 'sess-2' })} open onOpenChange={() => {}} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet.mock.calls[1][0]).toContain('sess-2');
  });
});

describe('SessionDrawer — header', () => {
  it('marks a preview session', async () => {
    render(<SessionDrawer item={item({ isPreview: true })} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('Preview')).toBeInTheDocument());
  });

  it('renders placeholders for an unassigned client, cohort, and round', async () => {
    render(
      <SessionDrawer
        item={item({ clientName: null, cohortName: null, roundName: null })}
        open
        onOpenChange={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});

describe('SessionDrawer — tabs', () => {
  it('shows the transcript by default and an empty state when there are no turns', async () => {
    mockGet.mockResolvedValue(adminView({ turns: [] }));
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No conversation yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('badges the Evaluations tab with the count, and omits it at zero', async () => {
    const { rerender } = render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Evaluations/ })).toBeInTheDocument()
    );
    expect(screen.getByRole('tab', { name: /^Evaluations$/ })).toBeInTheDocument();

    mockGet.mockResolvedValue(
      adminView({ evaluations: [{ id: 'e1', turnOrdinal: 1, overallScore: 4 }] })
    );
    rerender(<SessionDrawer item={item({ sessionId: 'sess-9' })} open onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Evaluations\s*1/ })).toBeInTheDocument()
    );
  });
});

describe('SessionDrawer — Report tab availability', () => {
  async function openReportTab() {
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Report' })).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    return user;
  }

  it('explains why there is no report when reports are disabled', async () => {
    mockGet.mockResolvedValue(
      adminView({
        report: null,
        availability: { state: 'disabled', message: 'Reports are turned off for this version.' },
      })
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openReportTab();

    expect(screen.getByText('Reports are turned off for this version.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate report/i })).not.toBeInTheDocument();
  });

  it('offers generation when a report can be produced but does not exist', async () => {
    mockGet.mockResolvedValue(
      adminView({
        report: { insights: null },
        availability: { state: 'generate', message: 'No report yet.' },
      })
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openReportTab();

    expect(screen.getByRole('button', { name: /generate report/i })).toBeInTheDocument();
  });

  it('posts the generate request and reloads on success', async () => {
    mockGet.mockResolvedValue(
      adminView({
        report: { insights: null },
        availability: { state: 'generate', message: 'No report yet.' },
      })
    );
    mockPost.mockResolvedValue({});
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    const user = await openReportTab();

    await user.click(screen.getByRole('button', { name: /generate report/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][0]).toContain('sess-1');
    // onGenerated triggers a silent reload so the queued report's state appears.
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('surfaces a generate failure and leaves the button usable', async () => {
    mockGet.mockResolvedValue(
      adminView({
        report: { insights: null },
        availability: { state: 'generate', message: 'No report yet.' },
      })
    );
    mockPost.mockRejectedValue(new APIClientError('A report is already in flight.'));
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    const user = await openReportTab();

    await user.click(screen.getByRole('button', { name: /generate report/i }));

    await waitFor(() =>
      expect(screen.getByText('A report is already in flight.')).toBeInTheDocument()
    );
    // Re-clickable rather than a stuck spinner — the endpoint 409s on a duplicate.
    expect(screen.getByRole('button', { name: /generate report/i })).toBeEnabled();
  });

  it('reports a failed generation with its error', async () => {
    mockGet.mockResolvedValue(
      adminView({
        report: { insights: { status: 'failed', error: 'provider timeout', content: null } },
        availability: { state: 'exists', message: '' },
      })
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openReportTab();

    expect(screen.getByText(/provider timeout/)).toBeInTheDocument();
  });
});

describe('SessionDrawer — method panel', () => {
  async function openReportTab() {
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Report' })).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Report' }));
    return user;
  }

  it('renders the admin method panel when the payload carries a record', async () => {
    mockGet.mockResolvedValue(adminView({ method: methodView() }));
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openReportTab();

    expect(screen.getByText('How this report was created')).toBeInTheDocument();
    // Admin projection — operational detail is present here (and only here).
    expect(screen.getByText(/gpt-5\.4 \(reasoning\)/)).toBeInTheDocument();
  });

  it('offers nothing when the report predates method capture', async () => {
    mockGet.mockResolvedValue(adminView({ method: null }));
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openReportTab();

    expect(screen.queryByText('How this report was created')).not.toBeInTheDocument();
  });
});

describe('SessionDrawer — Evaluations tab', () => {
  /** One persisted verdict summary, as `/admin-view` returns it. */
  function evaluation(over: Record<string, unknown> = {}) {
    return {
      id: 'ev-1',
      turnOrdinal: 3,
      overallScore: 4,
      effectiveness: 'Good',
      flagStatus: 'none',
      commentPreview: null,
      createdAt: '2026-07-16T11:00:00.000Z',
      ...over,
    };
  }

  /**
   * A minimal-but-complete valid verdict — the schema is strict, so a hand-waved shape falls into
   * the "could not be read" branch and would make the happy-path tests silently assert nothing.
   */
  function validVerdict() {
    return {
      overallScore: 82,
      effectiveness: 'Good',
      calls: [
        {
          name: 'Answer extraction',
          purpose: 'Map answer to slots',
          score: 80,
          instructionCompliance: 'Followed the schema.',
          outputQuality: 'Correct.',
          risks: 'Low.',
          improvements: 'None.',
        },
      ],
      interviewer: {
        openEndedness: 8,
        singleTopicFocus: 9,
        nonLeading: 7,
        conversational: 8,
        cognitiveLoad: 9,
        specificity: 7,
        warmth: 8,
        stageAlignment: 8,
        violations: [],
      },
      extraction: {
        score: 84,
        confidenceQuality: 'reasonable',
        coverage: 'Housing slot.',
        missedSignals: 'None.',
        overreach: 'None.',
      },
      questionSelection: {
        score: 79,
        relevance: 'Built on the answer.',
        coverageStrategy: 'Advanced coverage.',
        timing: 'Right moment.',
        alternatives: 'Tenure.',
      },
      informationGain: { rating: 'Medium', analysis: 'One slot.' },
      missedOpportunities: 'Cost burden.',
      promptDrift: { rating: 'None', evidence: [] },
      efficiency: { rating: 'Good', analysis: 'Justified.' },
      summary: {
        strengths: ['Clear'],
        weaknesses: ['Leading'],
        biggestRisk: 'Over-inference',
        biggestOpportunity: 'Probe cost',
        recommendedAction: 'Tighten rubric',
      },
    };
  }

  /** The detail payload the expanded row fetches. */
  function detail(over: Record<string, unknown> = {}) {
    return {
      evaluation: {
        id: 'ev-1',
        sessionId: 'sess-1',
        turnOrdinal: 3,
        flagStatus: 'none',
        comment: null,
        datasetId: null,
        evaluatorModel: 'gpt-5.4',
        verdict: validVerdict(),
        ...over,
      },
    };
  }

  async function openEvaluationsTab() {
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Evaluations/ })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('tab', { name: /Evaluations/ }));
    return user;
  }

  it('lists saved verdicts with their turn, score, and effectiveness band', async () => {
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('admin-view') ? adminView({ evaluations: [evaluation()] }) : detail()
      )
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    expect(screen.getByText('Turn 3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
  });

  it('shows the review flag only when a row has been flagged', async () => {
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('admin-view')
          ? adminView({ evaluations: [evaluation({ flagStatus: 'flagged' })] })
          : detail()
      )
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    expect(screen.getByText('flagged')).toBeInTheDocument();
  });

  it('expands the first verdict by default and fetches its detail', async () => {
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('admin-view') ? adminView({ evaluations: [evaluation()] }) : detail()
      )
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    // A verdict is on screen without a click.
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());
    expect(screen.getByTestId('review')).toBeInTheDocument();
  });

  it('collapses and re-expands a row on click', async () => {
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('admin-view') ? adminView({ evaluations: [evaluation()] }) : detail()
      )
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    const user = await openEvaluationsTab();
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());

    const row = screen.getByRole('button', { expanded: true });
    await user.click(row);
    expect(screen.queryByTestId('verdict')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());
  });

  it('surfaces a detail-fetch failure without breaking the tab', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('admin-view')
        ? Promise.resolve(adminView({ evaluations: [evaluation()] }))
        : Promise.reject(new APIClientError('Evaluation was pruned.'))
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    await waitFor(() => expect(screen.getByText('Evaluation was pruned.')).toBeInTheDocument());
    // The row itself still renders.
    expect(screen.getByText('Turn 3')).toBeInTheDocument();
  });

  it('reports an unreadable verdict rather than rendering a broken one', async () => {
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('admin-view')
          ? adminView({ evaluations: [evaluation()] })
          : detail({ verdict: { nonsense: true } })
      )
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    await waitFor(() => expect(screen.getByText(/verdict could not be read/i)).toBeInTheDocument());
    expect(screen.queryByTestId('verdict')).not.toBeInTheDocument();
  });

  it('always offers the run-an-evaluation panel, even with no saved verdicts', async () => {
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await openEvaluationsTab();

    expect(screen.getByTestId('ref-lookup')).toBeInTheDocument();
    expect(screen.queryByText(/Saved evaluations/i)).not.toBeInTheDocument();
  });
});

describe('SessionDrawer — generating poll', () => {
  it('polls while a report is generating and stops once it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(
      adminView({ report: { insights: { status: 'processing', content: null } } })
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Report lands ready — the interval must be torn down.
    mockGet.mockResolvedValue(adminView());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    const afterReady = mockGet.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(mockGet).toHaveBeenCalledTimes(afterReady);
  });

  it('does not poll for a report that is already ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good view when a silent reload fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(
      adminView({ report: { insights: { status: 'processing', content: null } } })
    );
    render(<SessionDrawer item={item()} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('workspace')).toBeInTheDocument());

    mockGet.mockRejectedValue(new Error('transient'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    // No error screen — a failed poll must not blow away the drawer.
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load this session/i)).not.toBeInTheDocument();
  });
});
