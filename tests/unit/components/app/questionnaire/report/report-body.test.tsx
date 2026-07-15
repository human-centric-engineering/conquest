/**
 * Shared respondent-report renderers — component tests.
 *
 * Covers both render variants (`screen` theme tokens / `paper` A4) and the optional sections
 * (appendix, research table + list, partial-completion caveat), plus the paper masthead and the
 * questionnaire-data appendix. These pure renderers are shared by the respondent completion screen and
 * the admin config preview, so their branch behaviour is pinned here directly.
 *
 * @see components/app/questionnaire/report/report-body.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  ReportBody,
  ReportPaperHeader,
  ReportDataAppendix,
} from '@/components/app/questionnaire/report/report-body';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';
import type { RespondentReportHeader } from '@/lib/app/questionnaire/report/view';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

const content = (over: Partial<RespondentReportContent> = {}): RespondentReportContent => ({
  summary: 'First point here. Second point here.\n\nA new paragraph follows.',
  sections: [{ heading: 'Strengths', body: 'You are consistent. You follow through.' }],
  actions: ['Keep a journal', 'Review weekly'],
  ...over,
});

describe('ReportBody', () => {
  it('renders the paper variant with appendix, research table, and the partial-completion caveat', () => {
    render(
      <ReportBody
        content={content({
          appendix: { heading: 'Further reading', body: 'Some supporting context.' },
          research: {
            findings: [
              {
                title: 'A source',
                url: 'https://example.com/a',
                snippet: 'Snippet A',
                source: 'Example',
              },
            ],
            display: 'table',
            note: 'A short synthesis.',
          },
        })}
        formatted={false}
        completionPct={40}
        variant="paper"
        animate={false}
      />
    );
    expect(screen.getByText('Strengths')).toBeInTheDocument();
    expect(screen.getByText('What you can do next')).toBeInTheDocument();
    expect(screen.getByText('Further reading')).toBeInTheDocument();
    expect(screen.getByText('Research & sources')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'A source' })).toHaveAttribute(
      'href',
      'https://example.com/a'
    );
    // Below the 75% threshold → the deterministic caveat renders.
    expect(screen.getByRole('note')).toHaveTextContent(/partially complete/i);
  });

  it('renders the screen variant with a research list and no caveat at full completion', () => {
    render(
      <ReportBody
        content={content({
          research: {
            findings: [
              { title: 'Listed source', url: 'https://example.com/b', snippet: 'Snippet B' },
            ],
            display: 'list',
          },
        })}
        formatted
        completionPct={100}
        variant="screen"
        animate
      />
    );
    expect(screen.getByRole('link', { name: 'Listed source' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('omits the actions/appendix/research blocks when empty', () => {
    render(
      <ReportBody
        content={{ summary: 'Just a summary.', sections: [], actions: [] }}
        formatted={false}
        completionPct={null}
        variant="screen"
      />
    );
    expect(screen.getByText('Just a summary.')).toBeInTheDocument();
    expect(screen.queryByText('What you can do next')).toBeNull();
    expect(screen.queryByText('Research & sources')).toBeNull();
  });
});

const header = (over: Partial<RespondentReportHeader> = {}): RespondentReportHeader => ({
  logoUrl: 'https://cdn.example.com/logo.png',
  accentColor: '#abcdef',
  versionNumber: 3,
  ref: 'GSP289HB',
  goal: 'Understand engagement',
  audienceSummary: 'Employees',
  respondentLabel: 'Ada Lovelace',
  completedAt: '2026-06-02T10:30:00.000Z',
  ...over,
});

describe('ReportPaperHeader', () => {
  it('renders the branded masthead with all metadata rows and the logo', () => {
    const { container } = render(<ReportPaperHeader title="Pulse" header={header()} />);
    expect(screen.getByRole('heading', { name: 'Pulse' })).toBeInTheDocument();
    expect(screen.getByText('Understand engagement')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // The brand logo is decorative (alt=""), so query the element directly rather than by role.
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example.com/logo.png'
    );
  });

  it('falls back to just the title when there is no header, and no logo when unset', () => {
    const { container } = render(<ReportPaperHeader title="Pulse" header={null} />);
    expect(screen.getByRole('heading', { name: 'Pulse' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    // No metadata rows without a header.
    expect(screen.queryByText('Employees')).toBeNull();
  });
});

function dsSlot(over: Partial<DataSlotPanelSlot> = {}): DataSlotPanelSlot {
  return {
    key: 'ds1',
    name: 'Focus needs',
    description: 'How they work',
    paraphrase: 'Prefers deep blocks.',
    provenance: 'direct',
    confidence: 0.8,
    rationale: null,
    filled: true,
    provisional: false,
    answeredAtTurnIndex: 1,
    history: [],
    coverage: { total: 1, answered: 1, questions: [] },
    ...over,
  };
}

function qSlot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'q1',
    prompt: 'Mood?',
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: true,
    value: 'Positive',
    paraphrase: null,
    provenance: 'direct',
    confidence: null,
    rationale: null,
    respondentEdited: false,
    answeredAtTurnIndex: 1,
    refinementHistory: [],
    ...over,
  };
}

const panel = (over: Partial<AnswerPanelView> = {}): AnswerPanelView => ({
  status: 'completed',
  scope: 'full_progress',
  sections: [{ sectionId: 's1', title: 'Wellbeing', slots: [qSlot()] }],
  answeredCount: 1,
  totalCount: 1,
  dataSlotGroups: [{ theme: 'Working style', slots: [dsSlot()] }],
  ...over,
});

describe('ReportDataAppendix', () => {
  it('renders the captured-information + responses sections, incl. unfilled/unanswered rows', () => {
    render(
      <ReportDataAppendix
        captured={panel({
          sections: [
            {
              sectionId: 's1',
              title: 'Wellbeing',
              slots: [
                qSlot(),
                qSlot({ slotKey: 'q2', prompt: 'Pending?', answered: false, value: null }),
              ],
            },
          ],
          dataSlotGroups: [
            {
              theme: 'Working style',
              slots: [
                dsSlot(),
                dsSlot({ key: 'ds2', name: 'Collaboration', paraphrase: null, filled: false }),
              ],
            },
          ],
        })}
        include={{ questions: true, dataSlots: true }}
        variant="screen"
      />
    );
    expect(screen.getByText('Captured information')).toBeInTheDocument();
    expect(screen.getByText('Prefers deep blocks.')).toBeInTheDocument();
    expect(screen.getByText('Not captured')).toBeInTheDocument(); // unfilled data slot
    expect(screen.getByText('Your responses')).toBeInTheDocument();
    expect(screen.getByText('Positive')).toBeInTheDocument();
    expect(screen.getByText('Not answered')).toBeInTheDocument(); // unanswered question
  });

  it('renders nothing when captured is null or nothing is included', () => {
    const { container: c1 } = render(
      <ReportDataAppendix captured={null} include={{ questions: true, dataSlots: true }} />
    );
    expect(c1).toBeEmptyDOMElement();

    const { container: c2 } = render(
      <ReportDataAppendix captured={panel()} include={{ questions: false, dataSlots: false }} />
    );
    expect(c2).toBeEmptyDOMElement();
  });
});
