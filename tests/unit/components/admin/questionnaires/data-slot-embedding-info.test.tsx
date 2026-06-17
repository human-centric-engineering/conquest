/**
 * DataSlotEmbeddingInfo component tests.
 *
 * DataSlotEmbeddingInfo is a static, server-renderable explainer (a native `<details>` card) shown on
 * the Questionnaires dashboard. It carries no fetch or hooks — the only behaviour worth pinning is
 * that the three use-cases render and that each consumer's on/off pill reflects the flag passed in.
 *
 * @see components/admin/questionnaires/data-slot-embedding-info.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { DataSlotEmbeddingInfo } from '@/components/admin/questionnaires/data-slot-embedding-info';

/** Find the use-case row whose title matches, then read its status pill text ('On' | 'Off' | none). */
function pillFor(title: string | RegExp): string | null {
  const heading = screen.getByText(title);
  // title <span> and pill <span> are siblings under the row's flex header.
  const header = heading.parentElement;
  if (!header) return null;
  const pill = within(header)
    .queryAllByText(/^(On|Off)$/)
    .at(0);
  return pill?.textContent ?? null;
}

describe('DataSlotEmbeddingInfo', () => {
  it('renders the three use-cases (large surveys, adaptive selection, extraction pre-filter)', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled={false} />);

    expect(screen.getByText('Large questionnaires')).toBeInTheDocument();
    expect(screen.getByText('Adaptive question selection')).toBeInTheDocument();
    expect(screen.getByText('Extraction pre-filter (large surveys)')).toBeInTheDocument();
    // The explainer names where embeddings are generated.
    expect(screen.getAllByText(/Generate\s+embeddings/).length).toBeGreaterThan(0);
  });

  it('shows the live On pill for adaptive selection when its flag is enabled', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled />);
    expect(pillFor('Adaptive question selection')).toBe('On');
  });

  it('shows an Off pill for adaptive selection when its flag is disabled', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled={false} />);
    expect(pillFor('Adaptive question selection')).toBe('Off');
  });

  it('does not attach a status pill to the flagless rows (large surveys, extraction pre-filter)', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled />);

    expect(pillFor('Large questionnaires')).toBeNull();
    // The pre-filter is now a per-questionnaire Settings toggle, not a global flag → no pill.
    expect(pillFor('Extraction pre-filter (large surveys)')).toBeNull();
  });
});
