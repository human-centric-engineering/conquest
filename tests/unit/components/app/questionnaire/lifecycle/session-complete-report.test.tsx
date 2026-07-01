/**
 * SessionComplete — respondent report integration (insights states + delivery gating).
 *
 * The base completion screen is covered elsewhere; this focuses on the Phase-5 additions: the
 * insights panel states (preparing / ready / failed) and the download-button gating driven by the
 * report view. The `useRespondentReport` hook is mocked to control the view.
 *
 * @see components/app/questionnaire/lifecycle/session-complete.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/hooks/use-respondent-report', () => ({ useRespondentReport: vi.fn() }));
vi.mock('@/lib/hooks/use-prefers-reduced-motion', () => ({
  usePrefersReducedMotion: vi.fn(() => false),
}));

import { useRespondentReport } from '@/lib/hooks/use-respondent-report';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

type Mock = ReturnType<typeof vi.fn>;
const retrySpy = vi.fn();
const mockView = (view: unknown, extra?: { timedOut?: boolean }) =>
  (useRespondentReport as unknown as Mock).mockReturnValue({
    view,
    loaded: true,
    timedOut: extra?.timedOut ?? false,
    retry: retrySpy,
  });
const setReducedMotion = (reduced: boolean) =>
  (usePrefersReducedMotion as unknown as Mock).mockReturnValue(reduced);

/** A minimal data-slot panel view with one filled, paraphrased slot. */
const dataSlotPanel = (): AnswerPanelView => ({
  status: 'completed',
  scope: 'answered_only',
  sections: [],
  answeredCount: 2,
  totalCount: 2,
  dataSlotGroups: [
    {
      theme: 'Wellbeing',
      slots: [
        {
          key: 'sleep',
          name: 'Sleep quality',
          description: '',
          paraphrase: 'You sleep well most nights.',
          provenance: 'direct',
          confidence: 0.9,
          rationale: null,
          filled: true,
          provisional: false,
          answeredAtTurnIndex: 2,
          history: [],
          coverage: { total: 1, answered: 1, questions: [] },
        },
      ],
    },
  ],
});

/** A data-slot panel with N filled, paraphrased slots — for exercising the cycler. */
const dataSlotPanelMany = (paraphrases: string[]): AnswerPanelView => ({
  status: 'completed',
  scope: 'answered_only',
  sections: [],
  answeredCount: paraphrases.length,
  totalCount: paraphrases.length,
  dataSlotGroups: [
    {
      theme: 'Wellbeing',
      slots: paraphrases.map((paraphrase, i) => ({
        key: `slot-${i}`,
        name: `Topic ${i}`,
        description: '',
        paraphrase,
        provenance: 'direct',
        confidence: 0.9,
        rationale: null,
        filled: true,
        provisional: false,
        answeredAtTurnIndex: i,
        history: [],
        coverage: { total: 1, answered: 1, questions: [] },
      })),
    },
  ],
});

/** A question-mode slot (no data-slot grouping) — for the `sections` extraction path. */
const questionSlot = (prompt: string, value: unknown, answered = true): PanelSlotView => ({
  slotKey: prompt,
  prompt,
  type: 'free_text',
  typeConfig: null,
  required: false,
  answered,
  value,
  provenance: 'direct',
  confidence: 0.9,
  rationale: null,
  answeredAtTurnIndex: 1,
  respondentEdited: false,
  refinementHistory: [],
});

/** A question-mode panel (sections, no dataSlotGroups). */
const questionPanel = (slots: PanelSlotView[]): AnswerPanelView => ({
  status: 'completed',
  scope: 'answered_only',
  sections: [{ sectionId: 's1', title: 'Section', slots }],
  answeredCount: slots.filter((s) => s.answered).length,
  totalCount: slots.length,
});

beforeEach(() => {
  vi.clearAllMocks();
  setReducedMotion(false);
});

describe('SessionComplete — respondent report', () => {
  it('keeps the default Download PDF when no report is configured', () => {
    mockView({ enabled: false, mode: 'raw', onScreen: true, download: true, insights: null });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByRole('button', { name: /Download PDF/i })).toBeInTheDocument();
    expect(screen.queryByText(/Preparing your personalised report/i)).not.toBeInTheDocument();
  });

  it('shows the preparing state while insights are queued', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByText(/Preparing your personalised report/i)).toBeInTheDocument();
  });

  it('renders the insights summary, sections, and actions when ready', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        content: {
          summary: 'You are highly engaged.',
          sections: [{ heading: 'Strengths', body: 'Consistent positivity.' }],
          actions: ['Block focus time'],
        },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByText('You are highly engaged.')).toBeInTheDocument();
    expect(screen.getByText('Strengths')).toBeInTheDocument();
    expect(screen.getByText('Block focus time')).toBeInTheDocument();
    expect(screen.getByText(/What you can do next/i)).toBeInTheDocument();
  });

  it('renders the woven report on-screen for narrative mode when ready', () => {
    mockView({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        content: {
          summary: 'Here is your story so far.',
          sections: [{ heading: 'Where you are now', body: 'Woven prose with your answers.' }],
          actions: ['Try this next'],
        },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByText('Here is your story so far.')).toBeInTheDocument();
    expect(screen.getByText('Where you are now')).toBeInTheDocument();
    expect(screen.getByText('Try this next')).toBeInTheDocument();
  });

  it('shows the preparing state for a narrative report still generating', () => {
    mockView({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      insights: { status: 'processing', content: null, generatedAt: null, error: null },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByText(/Preparing your personalised report/i)).toBeInTheDocument();
  });

  it('shows a calm fallback when generation failed', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'failed', content: null, generatedAt: null, error: 'boom' },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByText(/couldn.t prepare your personalised insights/i)).toBeInTheDocument();
  });

  it('echoes the positions the respondent shared while the report is preparing', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    render(<SessionComplete sessionId="s1" answeredCount={2} captured={dataSlotPanel()} />);
    expect(screen.getByText(/In the meantime, here.s what you shared/i)).toBeInTheDocument();
    // The first filled slot's paraphrase is shown (jsdom matchMedia → no reduced motion → cycler).
    expect(screen.getByText('You sleep well most nights.')).toBeInTheDocument();
    expect(screen.getByText('Sleep quality')).toBeInTheDocument();
  });

  it('advances the cycler to the next shared position over time', async () => {
    vi.useFakeTimers();
    try {
      mockView({
        enabled: true,
        mode: 'raw_plus_insights',
        onScreen: true,
        download: true,
        insights: { status: 'queued', content: null, generatedAt: null, error: null },
      });
      render(
        <SessionComplete
          sessionId="s1"
          answeredCount={2}
          captured={dataSlotPanelMany(['First position.', 'Second position.'])}
        />
      );
      // Cycler starts on the first position…
      expect(screen.getByText('First position.')).toBeInTheDocument();
      expect(screen.queryByText('Second position.')).not.toBeInTheDocument();
      // …and advances to the second after the interval elapses.
      act(() => void vi.advanceTimersByTime(3200));
      expect(screen.getByText('Second position.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a static list (no cycler) under prefers-reduced-motion', () => {
    setReducedMotion(true);
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    render(
      <SessionComplete
        sessionId="s1"
        answeredCount={3}
        captured={dataSlotPanelMany(['Alpha note.', 'Beta note.', 'Gamma note.'])}
      />
    );
    // All three are present at once (static list), not one-at-a-time.
    expect(screen.getByText('Alpha note.')).toBeInTheDocument();
    expect(screen.getByText('Beta note.')).toBeInTheDocument();
    expect(screen.getByText('Gamma note.')).toBeInTheDocument();
  });

  it('echoes question-mode answers (sections path), formatting and skipping values', () => {
    setReducedMotion(true); // static list → all snippets render at once for assertion
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    render(
      <SessionComplete
        sessionId="s1"
        answeredCount={2}
        captured={questionPanel([
          questionSlot('Favourite colour', 'Blue'),
          questionSlot('Hobbies', ['Reading', 'Cycling']),
          questionSlot('Complex', { nested: true }), // object → skipped
          questionSlot('Unanswered', 'ignored', false), // not answered → skipped
        ])}
      />
    );
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.getByText('Reading, Cycling')).toBeInTheDocument();
    // The object-valued and unanswered slots produce no echo.
    expect(screen.queryByText('Complex')).not.toBeInTheDocument();
    expect(screen.queryByText('Unanswered')).not.toBeInTheDocument();
  });

  it('falls back to the plain caption when there are no captured positions', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    render(<SessionComplete sessionId="s1" answeredCount={null} />);
    expect(screen.getByText(/Preparing your personalised report/i)).toBeInTheDocument();
    expect(screen.queryByText(/here.s what you shared/i)).not.toBeInTheDocument();
    // answeredCount null → the generic acknowledgement copy.
    expect(screen.getByText(/There.s nothing more you need to do/i)).toBeInTheDocument();
  });

  it('offers a calm retry when generation outruns the poll window', async () => {
    mockView(
      {
        enabled: true,
        mode: 'raw_plus_insights',
        onScreen: true,
        download: true,
        insights: { status: 'processing', content: null, generatedAt: null, error: null },
      },
      { timedOut: true }
    );
    render(<SessionComplete sessionId="s1" answeredCount={2} />);
    expect(screen.getByText(/taking a little longer than usual/i)).toBeInTheDocument();
    // The cycler/spinner is replaced by the fallback, not shown alongside it.
    expect(screen.queryByText(/Preparing your personalised report/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Check again/i }));
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it('hides the Download button when delivery.download is off', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: false,
      insights: {
        status: 'ready',
        content: { summary: 'x', sections: [], actions: [] },
        generatedAt: null,
        error: null,
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.queryByRole('button', { name: /Download PDF/i })).not.toBeInTheDocument();
  });
});
