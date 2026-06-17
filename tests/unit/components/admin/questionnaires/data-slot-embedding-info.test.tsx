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
    render(
      <DataSlotEmbeddingInfo adaptiveDataSlotsEnabled={false} extractionPrefilterEnabled={false} />
    );

    expect(screen.getByText('Large questionnaires')).toBeInTheDocument();
    expect(screen.getByText('Adaptive question selection')).toBeInTheDocument();
    expect(screen.getByText('Answer-slot completion (extraction pre-filter)')).toBeInTheDocument();
    // The explainer names where embeddings are generated.
    expect(screen.getAllByText(/Generate\s+embeddings/).length).toBeGreaterThan(0);
  });

  it('shows an On pill for each consumer whose flag is enabled', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled extractionPrefilterEnabled />);

    expect(pillFor('Adaptive question selection')).toBe('On');
    expect(pillFor('Answer-slot completion (extraction pre-filter)')).toBe('On');
  });

  it('shows an Off pill for each consumer whose flag is disabled', () => {
    render(
      <DataSlotEmbeddingInfo adaptiveDataSlotsEnabled={false} extractionPrefilterEnabled={false} />
    );

    expect(pillFor('Adaptive question selection')).toBe('Off');
    expect(pillFor('Answer-slot completion (extraction pre-filter)')).toBe('Off');
  });

  it('reflects each flag independently (adaptive on, pre-filter off)', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled extractionPrefilterEnabled={false} />);

    expect(pillFor('Adaptive question selection')).toBe('On');
    expect(pillFor('Answer-slot completion (extraction pre-filter)')).toBe('Off');
  });

  it('does not attach a status pill to the flagless "Large questionnaires" row', () => {
    render(<DataSlotEmbeddingInfo adaptiveDataSlotsEnabled extractionPrefilterEnabled />);

    expect(pillFor('Large questionnaires')).toBeNull();
  });
});
