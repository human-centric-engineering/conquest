/**
 * AnswerSlotPanel (+ AnswerSlotItem) — rendering, scope header, expand, Revisit (F7.2).
 *
 * @see components/app/questionnaire/panel/answer-slot-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

function answeredSlot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'role',
    prompt: 'What is your role?',
    type: 'free_text',
    required: true,
    answered: true,
    value: 'Engineer',
    provenance: 'direct',
    confidence: 0.9,
    rationale: 'Stated directly.',
    answeredAtTurnIndex: 1,
    refinementHistory: [],
    ...over,
  };
}

function pendingSlot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'team',
    prompt: 'How big is your team?',
    type: 'numeric',
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

function view(over: Partial<AnswerPanelView> = {}): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [{ sectionId: 's1', title: 'About you', slots: [answeredSlot(), pendingSlot()] }],
    answeredCount: 1,
    totalCount: 2,
    ...over,
  };
}

describe('AnswerSlotPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a loading message when view is null and loading', () => {
    render(<AnswerSlotPanel view={null} loading />);
    expect(screen.getByText(/Loading your answers/)).toBeInTheDocument();
  });

  it('shows "No answers yet." when view is null and not loading', () => {
    render(<AnswerSlotPanel view={null} />);
    expect(screen.getByText('No answers yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Loading your answers/)).not.toBeInTheDocument();
  });

  it('shows the X-of-N progress header in full_progress', () => {
    render(<AnswerSlotPanel view={view()} />);
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument();
  });

  it('shows the captured count header in answered_only', () => {
    render(
      <AnswerSlotPanel
        view={view({
          scope: 'answered_only',
          sections: [{ sectionId: 's1', title: 'About you', slots: [answeredSlot()] }],
        })}
      />
    );
    expect(screen.getByText('1 captured')).toBeInTheDocument();
  });

  it('renders answered values and pending placeholders', () => {
    render(<AnswerSlotPanel view={view()} />);
    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getByText('Not answered yet')).toBeInTheDocument();
    expect(screen.getByText('About you')).toBeInTheDocument();
  });

  it('expands an answered slot to reveal its rationale on click', () => {
    render(<AnswerSlotPanel view={view()} />);
    expect(screen.queryByText('Stated directly.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('What is your role?'));
    expect(screen.getByText('Stated directly.')).toBeInTheDocument();
  });

  it('does not expand a pending slot', () => {
    render(<AnswerSlotPanel view={view()} />);
    const pendingButton = screen.getByText('How big is your team?').closest('button');
    expect(pendingButton).toBeDisabled();
  });

  it('Revisit requires a confirm, then calls onRevisit with the slot', () => {
    const onRevisit = vi.fn();
    render(<AnswerSlotPanel view={view()} onRevisit={onRevisit} canRevisit />);

    fireEvent.click(screen.getByText('What is your role?'));
    fireEvent.click(screen.getByRole('button', { name: 'Revisit' }));
    // Not sent until the confirm.
    expect(onRevisit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revisit' }));
    expect(onRevisit).toHaveBeenCalledWith(expect.objectContaining({ slotKey: 'role' }));
  });

  it('disables Revisit when canRevisit is false', () => {
    render(<AnswerSlotPanel view={view()} onRevisit={vi.fn()} canRevisit={false} />);
    fireEvent.click(screen.getByText('What is your role?'));
    expect(screen.getByRole('button', { name: 'Revisit' })).toBeDisabled();
  });

  it('hides the Revisit affordance when onRevisit is not provided', () => {
    render(<AnswerSlotPanel view={view()} />);
    fireEvent.click(screen.getByText('What is your role?'));
    expect(screen.queryByRole('button', { name: 'Revisit' })).not.toBeInTheDocument();
  });
});
