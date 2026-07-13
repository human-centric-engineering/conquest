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
const notifySpy = vi.fn(() => Promise.resolve(true));
const mockView = (view: unknown, extra?: { timedOut?: boolean }) =>
  (useRespondentReport as unknown as Mock).mockReturnValue({
    view,
    loaded: true,
    timedOut: extra?.timedOut ?? false,
    retry: retrySpy,
    notify: notifySpy,
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
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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

  it('opens a branded A4 preview with the PDF-style masthead when Expand is clicked', async () => {
    const user = userEvent.setup();
    mockView({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      questionnaireTitle: 'Time Audit Test',
      header: {
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#2563eb',
        versionNumber: 1,
        ref: 'EEQMC0ES',
        goal: 'Help leaders reflect on their time.',
        audienceSummary: 'Leaders self-auditing.',
        respondentLabel: 'John Durrant',
        completedAt: '2026-07-03T10:00:00.000Z',
      },
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        content: { summary: 'Woven report.', sections: [], actions: [] },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={9} />);

    // The masthead only exists inside the preview dialog — not on the card — so nothing until Expand.
    expect(screen.queryByRole('heading', { name: 'Time Audit Test' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Expand/i }));

    // Masthead mirrors the PDF header: title, version, grouped ref, goal, audience, respondent, date.
    expect(screen.getByRole('heading', { name: 'Time Audit Test' })).toBeInTheDocument();
    expect(screen.getByText(/EEQM-C0ES/)).toBeInTheDocument();
    expect(screen.getByText(/Help leaders reflect on their time\./)).toBeInTheDocument();
    expect(screen.getByText(/Leaders self-auditing\./)).toBeInTheDocument();
    expect(screen.getByText(/John Durrant/)).toBeInTheDocument();
    expect(screen.getByText(/3 July 2026/)).toBeInTheDocument();
    // The demo-client logo renders (decorative alt="", so query the DOM rather than the a11y tree).
    expect(document.body.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example.com/logo.png'
    );
  });

  it('omits the logo image in the preview when no brand logo is configured', async () => {
    const user = userEvent.setup();
    mockView({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      questionnaireTitle: 'Time Audit Test',
      header: {
        logoUrl: null,
        accentColor: '#2563eb',
        versionNumber: 1,
        ref: null,
        goal: null,
        audienceSummary: null,
        respondentLabel: 'Anonymous respondent',
        completedAt: null,
      },
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        content: { summary: 'Woven report.', sections: [], actions: [] },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={9} />);
    await user.click(screen.getByRole('button', { name: /Expand/i }));
    expect(screen.getByRole('heading', { name: 'Time Audit Test' })).toBeInTheDocument();
    // No logoUrl → no image (the PDF behaves the same); the accent rule + title still render.
    expect(document.body.querySelector('img')).toBeNull();
    expect(screen.getByText(/Anonymous respondent/)).toBeInTheDocument();
  });

  it('hides Download PDF while an AI report is still generating', () => {
    // In an AI report mode the PDF *is* the report, so the download must not appear mid-generation.
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'processing',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.queryByRole('button', { name: /Download PDF/i })).not.toBeInTheDocument();
  });

  it('shows Download PDF once the AI report is ready', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        content: { summary: 'Ready.', sections: [], actions: [] },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.getByRole('button', { name: /Download PDF/i })).toBeInTheDocument();
  });

  it('renders the partial-report caveat when completion is below the threshold', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        completionPct: 40,
        content: { summary: 'Partial report.', sections: [], actions: [] },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(
      screen.getByText(/partially complete questionnaire \(40% complete\)/i)
    ).toBeInTheDocument();
  });

  it('omits the caveat when completion is at or above the threshold', () => {
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        generatedAt: '2026-06-19T12:00:00.000Z',
        error: null,
        completionPct: 90,
        content: { summary: 'Full report.', sections: [], actions: [] },
      },
    });
    render(<SessionComplete sessionId="s1" answeredCount={3} />);
    expect(screen.queryByText(/partially complete questionnaire/i)).not.toBeInTheDocument();
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
      insights: {
        status: 'processing',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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
      insights: {
        status: 'failed',
        started: true,
        content: null,
        generatedAt: null,
        error: 'boom',
        notifyRequested: false,
      },
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
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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
        insights: {
          status: 'queued',
          started: true,
          content: null,
          generatedAt: null,
          error: null,
          notifyRequested: false,
        },
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

  it('clamps a long cycler snippet so it cannot overflow the fixed-height slot', () => {
    // Regression: a long, multi-line paraphrase in the cross-fade slot used to overflow the fixed
    // height and overlap the "Preparing…" caption above it. The cross-fade body is now line-clamped.
    const longParaphrase =
      'They were told their management style is overly paternalistic and that they should stop ' +
      'being a union rep and be more of a boss, which they partly accept.';
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
    });
    render(
      <SessionComplete
        sessionId="s1"
        answeredCount={1}
        captured={dataSlotPanelMany([longParaphrase])}
      />
    );
    expect(screen.getByText(longParaphrase)).toHaveClass('line-clamp-3');
  });

  it('shows a static list (no cycler) under prefers-reduced-motion', () => {
    setReducedMotion(true);
    mockView({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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
      insights: {
        status: 'queued',
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested: false,
      },
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
        insights: {
          status: 'processing',
          started: true,
          content: null,
          generatedAt: null,
          error: null,
          notifyRequested: false,
        },
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

  describe('email-me-when-ready (timed-out fallback)', () => {
    const timedOutView = (notifyRequested = false) => ({
      enabled: true,
      mode: 'raw_plus_insights' as const,
      onScreen: true,
      download: true,
      insights: {
        status: 'processing' as const,
        started: true,
        content: null,
        generatedAt: null,
        error: null,
        notifyRequested,
      },
    });

    it('submits the entered email via notify() and swaps to a confirmation', async () => {
      notifySpy.mockResolvedValueOnce(true);
      mockView(timedOutView(), { timedOut: true });
      render(<SessionComplete sessionId="s1" answeredCount={2} />);

      await userEvent.type(
        screen.getByLabelText(/Email address for your report/i),
        'me@example.com'
      );
      await userEvent.click(screen.getByRole('button', { name: /Email me/i }));

      expect(notifySpy).toHaveBeenCalledWith('me@example.com');
      expect(
        await screen.findByText(/We.ll email you when your report is ready/i)
      ).toBeInTheDocument();
    });

    it('shows the confirmation directly when a notify was already requested', () => {
      mockView(timedOutView(true), { timedOut: true });
      render(<SessionComplete sessionId="s1" answeredCount={2} />);

      expect(screen.getByText(/We.ll email you when your report is ready/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Email me/i })).toBeNull();
    });

    it('surfaces an error when notify() fails', async () => {
      notifySpy.mockResolvedValueOnce(false);
      mockView(timedOutView(), { timedOut: true });
      render(<SessionComplete sessionId="s1" answeredCount={2} />);

      await userEvent.type(
        screen.getByLabelText(/Email address for your report/i),
        'me@example.com'
      );
      await userEvent.click(screen.getByRole('button', { name: /Email me/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t save your email/i);
    });

    it('surfaces an error when notify() rejects (network failure)', async () => {
      notifySpy.mockRejectedValueOnce(new Error('network down'));
      mockView(timedOutView(), { timedOut: true });
      render(<SessionComplete sessionId="s1" answeredCount={2} />);

      await userEvent.type(
        screen.getByLabelText(/Email address for your report/i),
        'me@example.com'
      );
      await userEvent.click(screen.getByRole('button', { name: /Email me/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t save your email/i);
    });
  });

  describe('download filename', () => {
    /** Drive a click on Download PDF with fetch/URL/anchor stubbed; return the anchor's download name. */
    async function downloadNameFor(view: unknown): Promise<string> {
      mockView(view);
      const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(blob, { status: 200 }));
      const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
      const revokeURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      // Capture the anchor the handler creates so we can read its `download` attribute. Bind the
      // original createElement first so the spy can still make non-anchor elements.
      const originalCreate = document.createElement.bind(document);
      const anchor = originalCreate('a');
      const clickSpy = vi.spyOn(anchor, 'click').mockImplementation(() => {});
      const createEl = vi
        .spyOn(document, 'createElement')
        .mockImplementation((tag: string) => (tag === 'a' ? anchor : originalCreate(tag)));

      render(<SessionComplete sessionId="s1" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /Download PDF/i }));

      createEl.mockRestore();
      fetchSpy.mockRestore();
      createURL.mockRestore();
      revokeURL.mockRestore();
      clickSpy.mockRestore();
      return anchor.download;
    }

    it('names the PDF after the questionnaire title (slugified)', async () => {
      const name = await downloadNameFor({
        enabled: true,
        mode: 'narrative',
        onScreen: false,
        download: true,
        questionnaireTitle: 'Merlin5 Alpha Demo',
        insights: {
          status: 'ready',
          content: { summary: 'x', sections: [], actions: [] },
          generatedAt: null,
          error: null,
        },
      });
      expect(name).toBe('merlin5-alpha-demo.pdf');
    });

    it('falls back to responses.pdf when there is no title', async () => {
      const name = await downloadNameFor({
        enabled: false,
        mode: 'raw',
        onScreen: true,
        download: true,
        insights: null,
      });
      expect(name).toBe('responses.pdf');
    });
  });

  describe('web research findings (report-web-search)', () => {
    it('renders findings as a table, with source and link, when display is "table"', () => {
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
            summary: 'Summary.',
            sections: [],
            actions: [],
            research: {
              display: 'table',
              note: 'Findings drawn from recent industry coverage.',
              findings: [
                {
                  title: 'Study A',
                  url: 'https://example.com/a',
                  snippet: 'Snippet A text.',
                  source: 'Example Journal',
                },
                {
                  // No `source` — exercises the branch that omits the source line.
                  title: 'Study B',
                  url: 'https://example.com/b',
                  snippet: 'Snippet B text.',
                },
              ],
            },
          },
        },
      });
      render(<SessionComplete sessionId="s1" answeredCount={3} />);

      expect(screen.getByText('Research & sources')).toBeInTheDocument();
      expect(screen.getByText('Findings drawn from recent industry coverage.')).toBeInTheDocument();

      const table = screen.getByRole('table');
      // `data-research-display` lives on the wrapping section, not the table itself.
      expect(table.closest('[data-research-display]')).toHaveAttribute(
        'data-research-display',
        'table'
      );
      expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Details' })).toBeInTheDocument();

      const linkA = screen.getByRole('link', { name: 'Study A' });
      expect(linkA).toHaveAttribute('href', 'https://example.com/a');
      expect(screen.getByText('Example Journal')).toBeInTheDocument();
      expect(screen.getByText('Snippet A text.')).toBeInTheDocument();

      const linkB = screen.getByRole('link', { name: 'Study B' });
      expect(linkB).toHaveAttribute('href', 'https://example.com/b');
      expect(screen.getByText('Snippet B text.')).toBeInTheDocument();
      // Study B has no source — its row (2nd body row) carries no source label at all.
      const rows = screen.getAllByRole('row');
      const rowB = rows.find((r) => r.textContent?.includes('Study B'));
      expect(rowB?.textContent).not.toContain('Example Journal');
    });

    it('renders findings as a list, without a note or source, when display is "list"', () => {
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
            summary: 'Summary.',
            sections: [],
            actions: [],
            research: {
              display: 'list',
              // No `note` — exercises the branch that omits the synthesis paragraph.
              findings: [{ title: 'Study C', url: 'https://example.com/c', snippet: '' }],
            },
          },
        },
      });
      render(<SessionComplete sessionId="s1" answeredCount={3} />);

      expect(screen.getByText('Research & sources')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();

      const link = screen.getByRole('link', { name: 'Study C' });
      expect(link).toHaveAttribute('href', 'https://example.com/c');
      // Empty snippet and absent source produce no extra text in this finding's list item.
      const item = link.closest('li');
      expect(item?.textContent?.trim()).toBe('Study C');
    });

    it('omits the research section entirely when there are no findings', () => {
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
            summary: 'Summary.',
            sections: [],
            actions: [],
            research: { display: 'list', findings: [] },
          },
        },
      });
      render(<SessionComplete sessionId="s1" answeredCount={3} />);
      expect(screen.queryByText('Research & sources')).not.toBeInTheDocument();
    });
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
