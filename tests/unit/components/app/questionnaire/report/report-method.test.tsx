/**
 * "How this report was created" panel — component tests.
 *
 * The audience split is enforced in `buildReportMethodView` (which omits the `admin` block entirely
 * from a respondent view), but that guarantee is only worth as much as the renderer honouring it. These
 * tests pin the render side directly: a respondent-shaped view must not put model, cost, search
 * queries, or document names on screen, and the panel must not display a section the record didn't
 * earn.
 *
 * @see components/app/questionnaire/report/report-method.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ReportMethodPanel } from '@/components/app/questionnaire/report/report-method';
import type { ReportMethodClientView } from '@/lib/app/questionnaire/report/method-view';

const view = (over: Partial<ReportMethodClientView> = {}): ReportMethodClientView => ({
  summary: 'We read the answers you gave and noted the ones you skipped.',
  preview: false,
  facts: [
    { key: 'answers', label: 'Your answers', value: '34 of 40' },
    { key: 'gaps', label: 'Questions noted as unanswered', value: '6' },
  ],
  sources: [],
  checks: ['Questions you did not answer were listed as gaps, so nothing was assumed about them.'],
  ...over,
});

const adminDetail = {
  model: { provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' },
  costUsd: 0.0412,
  durationMs: 2500,
  searches: [{ phase: 'before' as const, query: 'engagement benchmarks 2026', resultCount: 5 }],
  documents: [{ id: 'd1', name: 'Confidential Wellbeing Handbook', snippets: 2 }],
  stages: [
    { key: 'answers' as const, ran: true },
    { key: 'knowledge' as const, ran: false, skipReason: 'disabled' as const },
  ],
  summarySource: 'agent' as const,
};

describe('ReportMethodPanel — respondent surface', () => {
  it('renders the summary, the facts, and the checks', () => {
    render(<ReportMethodPanel view={view()} />);

    expect(screen.getByText(/We read the answers you gave/)).toBeInTheDocument();
    expect(screen.getByText('Your answers')).toBeInTheDocument();
    expect(screen.getByText('34 of 40')).toBeInTheDocument();
    expect(screen.getByText(/listed as gaps/)).toBeInTheDocument();
  });

  it('renders no admin detail when the view carries none', () => {
    const { container } = render(<ReportMethodPanel view={view()} />);

    expect(screen.queryByText(/Generation detail/i)).not.toBeInTheDocument();
    // Nothing operational leaks into the markup — not the model, cost, queries, or document names.
    expect(container.textContent).not.toMatch(/gpt-5\.4|openai|0\.0412|benchmarks|Handbook/);
  });

  it('omits the "What went into it" table entirely when there are no facts', () => {
    render(<ReportMethodPanel view={view({ facts: [] })} />);
    expect(screen.queryByText(/What went into it/i)).not.toBeInTheDocument();
  });

  it('omits the checks section when no check actually ran', () => {
    // A "Checks applied" heading over an empty list would imply diligence the record didn't record.
    render(<ReportMethodPanel view={view({ checks: [] })} />);
    expect(screen.queryByText(/Checks applied/i)).not.toBeInTheDocument();
  });

  it('links web sources externally with a safe rel and shows the host', () => {
    render(
      <ReportMethodPanel
        view={view({
          sources: [
            { title: 'Gallup engagement report', url: 'https://www.gallup.example/report' },
          ],
        })}
      />
    );

    const link = screen.getByRole('link', { name: /Gallup engagement report/ });
    expect(link).toHaveAttribute('href', 'https://www.gallup.example/report');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    // `www.` stripped so the provenance reads as a domain.
    expect(screen.getByText('gallup.example')).toBeInTheDocument();
  });

  it('falls back to the host when a source has no title', () => {
    render(
      <ReportMethodPanel view={view({ sources: [{ title: '', url: 'https://a.test/x' }] })} />
    );
    expect(screen.getByRole('link', { name: /a\.test/ })).toBeInTheDocument();
  });

  it('shows the sample banner for a preview record', () => {
    render(<ReportMethodPanel view={view({ preview: true })} />);
    expect(
      screen.getByText(/sample report generated from a made-up respondent/i)
    ).toBeInTheDocument();
  });

  it('shows no sample banner for a real run', () => {
    render(<ReportMethodPanel view={view()} />);
    expect(screen.queryByText(/made-up respondent/i)).not.toBeInTheDocument();
  });
});

describe('ReportMethodPanel — admin surface', () => {
  it('renders model, cost, duration, queries, documents, and stages', () => {
    render(<ReportMethodPanel view={view({ admin: adminDetail })} variant="admin" />);

    expect(screen.getByText(/Generation detail/i)).toBeInTheDocument();
    expect(screen.getByText(/gpt-5\.4 \(reasoning\)/)).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('$0.0412')).toBeInTheDocument();
    expect(screen.getByText('2.5s')).toBeInTheDocument();
    expect(screen.getByText(/engagement benchmarks 2026/)).toBeInTheDocument();
    expect(screen.getByText('Confidential Wellbeing Handbook')).toBeInTheDocument();
  });

  it('shows skipped stages with their reason, so a skip is never silent', () => {
    render(<ReportMethodPanel view={view({ admin: adminDetail })} variant="admin" />);

    expect(screen.getByText("Searched the client's documents")).toBeInTheDocument();
    expect(screen.getByText(/skipped — off in config/)).toBeInTheDocument();
  });

  it('attributes the explanation to the agent or the deterministic fallback', () => {
    const { rerender } = render(
      <ReportMethodPanel view={view({ admin: adminDetail })} variant="admin" />
    );
    expect(screen.getByText(/agent-written \(passed grounding checks\)/)).toBeInTheDocument();

    rerender(
      <ReportMethodPanel
        view={view({ admin: { ...adminDetail, summarySource: 'template' } })}
        variant="admin"
      />
    );
    expect(screen.getByText(/deterministic fallback/)).toBeInTheDocument();
  });

  it('formats sub-second and multi-minute durations', () => {
    const { rerender } = render(
      <ReportMethodPanel
        view={view({ admin: { ...adminDetail, durationMs: 420 } })}
        variant="admin"
      />
    );
    expect(screen.getByText('420ms')).toBeInTheDocument();

    rerender(
      <ReportMethodPanel
        view={view({ admin: { ...adminDetail, durationMs: 95_000 } })}
        variant="admin"
      />
    );
    expect(screen.getByText('1m 35s')).toBeInTheDocument();
  });
});
