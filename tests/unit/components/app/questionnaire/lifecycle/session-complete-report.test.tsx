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
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/hooks/use-respondent-report', () => ({ useRespondentReport: vi.fn() }));

import { useRespondentReport } from '@/lib/hooks/use-respondent-report';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';

type Mock = ReturnType<typeof vi.fn>;
const mockView = (view: unknown) =>
  (useRespondentReport as unknown as Mock).mockReturnValue({ view, loaded: true });

beforeEach(() => {
  vi.clearAllMocks();
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
