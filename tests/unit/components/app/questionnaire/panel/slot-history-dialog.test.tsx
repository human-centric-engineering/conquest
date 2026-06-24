/**
 * SlotHistoryDialog — the "Edited" pill + evolution modal for a data slot (F7.2).
 *
 * Covers the render-nothing guard, singular/plural pill labels, and the timeline
 * inside the dialog: current reading, prior steps, the "Reason not recorded" fallback,
 * and the timestamp → "Earlier" fallback for null/invalid `changedAt`.
 *
 * @see components/app/questionnaire/panel/slot-history-dialog.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { SlotHistoryDialog } from '@/components/app/questionnaire/panel/slot-history-dialog';
import type { DataSlotPanelSlot } from '@/lib/app/questionnaire/panel/types';

type HistoryEntry = DataSlotPanelSlot['history'][number];

function historyEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    paraphrase: 'Earlier reading.',
    confidence: 0.4,
    rationale: 'Stated earlier.',
    changedAt: '2026-06-24T14:30:00.000Z',
    ...over,
  };
}

function slot(over: Partial<DataSlotPanelSlot> = {}): DataSlotPanelSlot {
  return {
    key: 'gender',
    name: 'Gender',
    description: 'Their stated gender.',
    paraphrase: 'Female.',
    provenance: 'direct',
    confidence: 0.9,
    rationale: 'Corrected directly.',
    filled: true,
    provisional: false,
    answeredAtTurnIndex: 2,
    history: [],
    coverage: { total: 0, answered: 0, questions: [] },
    ...over,
  };
}

describe('SlotHistoryDialog', () => {
  it('renders nothing when there are no prior states', () => {
    const { container } = render(<SlotHistoryDialog slot={slot({ history: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when prior states carried no reading (filtered out)', () => {
    const { container } = render(
      <SlotHistoryDialog slot={slot({ history: [historyEntry({ paraphrase: null })] })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a singular "1 Edit" pill for a single prior state', () => {
    render(<SlotHistoryDialog slot={slot({ history: [historyEntry()] })} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('1 Edit');
    expect(trigger).not.toHaveTextContent('Edits');
    expect(trigger).toHaveAccessibleName('See how this answer evolved — 1 edit');
  });

  it('shows a plural "2 Edits" pill for multiple prior states', () => {
    render(
      <SlotHistoryDialog
        slot={slot({ history: [historyEntry(), historyEntry({ paraphrase: 'Older reading.' })] })}
      />
    );
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('2 Edits');
    expect(trigger).toHaveAccessibleName('See how this answer evolved — 2 edits');
  });

  it('opens a newest-first timeline with the current reading and a prior step', () => {
    render(
      <SlotHistoryDialog
        slot={slot({
          paraphrase: 'Female.',
          rationale: 'Corrected directly.',
          history: [historyEntry({ paraphrase: 'Male.', rationale: 'Stated as male.' })],
        })}
      />
    );
    fireEvent.click(screen.getByRole('button'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('How this answer evolved')).toBeInTheDocument();
    expect(within(dialog).getByText('Gender')).toBeInTheDocument();
    expect(within(dialog).getByText('Current')).toBeInTheDocument();
    expect(within(dialog).getByText(/Female\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/Male\./)).toBeInTheDocument();
    expect(within(dialog).getByText('Stated as male.')).toBeInTheDocument();
  });

  it('labels a prior step "Reason not recorded" when its rationale is null', () => {
    render(<SlotHistoryDialog slot={slot({ history: [historyEntry({ rationale: null })] })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reason not recorded')).toBeInTheDocument();
  });

  it('falls back to "Earlier" when a prior step has a null or invalid timestamp', () => {
    render(
      <SlotHistoryDialog
        slot={slot({
          history: [
            historyEntry({ changedAt: null, paraphrase: 'No stamp.' }),
            historyEntry({ changedAt: 'not-a-date', paraphrase: 'Bad stamp.' }),
          ],
        })}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByText('Earlier')).toHaveLength(2);
  });
});
