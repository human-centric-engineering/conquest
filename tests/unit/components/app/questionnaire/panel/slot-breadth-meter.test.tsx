/**
 * SlotBreadthMeter — the breadth (coverage) axis for a data-slot row.
 *
 * @see components/app/questionnaire/panel/slot-breadth-meter.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SlotBreadthMeter } from '@/components/app/questionnaire/panel/slot-breadth-meter';
import type { DataSlotCoverage } from '@/lib/app/questionnaire/panel/types';

function coverage(over: Partial<DataSlotCoverage> = {}): DataSlotCoverage {
  return { total: 3, answered: 2, questions: [], ...over };
}

describe('SlotBreadthMeter', () => {
  it('renders nothing when the slot maps to no questions', () => {
    const { container } = render(
      <SlotBreadthMeter coverage={coverage({ total: 0, answered: 0 })} expandable />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the N-of-M summary with pluralised wording', () => {
    render(<SlotBreadthMeter coverage={coverage({ total: 5, answered: 3 })} expandable={false} />);
    expect(screen.getByText('3 of 5 questions')).toBeInTheDocument();
  });

  it('uses the singular when the slot maps to one question', () => {
    render(<SlotBreadthMeter coverage={coverage({ total: 1, answered: 0 })} expandable={false} />);
    expect(screen.getByText('0 of 1 question')).toBeInTheDocument();
  });

  it('collapses the pips past MAX_PIPS (>6), keeping the fraction label', () => {
    const { container } = render(
      <SlotBreadthMeter coverage={coverage({ total: 7, answered: 3 })} expandable={false} />
    );
    // The fraction label still reads, but the pip row is suppressed so a many-question slot never sprawls.
    expect(screen.getByText('3 of 7 questions')).toBeInTheDocument();
    // The pips render as fixed-width rounded bars (h-1.5 w-2.5); none are present past the cap.
    expect(container.querySelectorAll('span.h-1\\.5.w-2\\.5')).toHaveLength(0);
  });

  it('renders one pip per question at or below the cap (6)', () => {
    const { container } = render(
      <SlotBreadthMeter coverage={coverage({ total: 6, answered: 2 })} expandable={false} />
    );
    expect(container.querySelectorAll('span.h-1\\.5.w-2\\.5')).toHaveLength(6);
  });

  it('is inert summary text (no disclosure) when not expandable, even with questions present', () => {
    render(
      <SlotBreadthMeter
        coverage={coverage({
          total: 2,
          answered: 1,
          questions: [{ label: 'Your name?', answered: true, confidence: 0.9 }],
        })}
        expandable={false}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not expand when expandable but no questions were shipped (chat-mode safety)', () => {
    render(<SlotBreadthMeter coverage={coverage({ questions: [] })} expandable />);
    // expandable is true, but with no itemised questions there is nothing to disclose.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('toggles the itemised question list (label + "not yet" state) in both mode', () => {
    render(
      <SlotBreadthMeter
        coverage={coverage({
          total: 2,
          answered: 1,
          questions: [
            { label: 'Your name?', answered: true, confidence: 0.9 },
            { label: 'Favourite colour?', answered: false, confidence: null },
          ],
        })}
        expandable
      />
    );
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed: the prompts are not in the DOM.
    expect(screen.queryByText('Your name?')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Your name?')).toBeInTheDocument();
    expect(screen.getByText('Favourite colour?')).toBeInTheDocument();
    // The unanswered question is flagged.
    expect(screen.getByText('not yet')).toBeInTheDocument();
  });
});
