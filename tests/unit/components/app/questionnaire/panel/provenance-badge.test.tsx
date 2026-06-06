/**
 * ProvenanceBadge — label copy per provenance, nothing when null (F7.2).
 *
 * @see components/app/questionnaire/panel/provenance-badge.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProvenanceBadge } from '@/components/app/questionnaire/panel/provenance-badge';

describe('ProvenanceBadge', () => {
  it('maps each provenance to its respondent-facing label', () => {
    const { rerender } = render(<ProvenanceBadge provenance="direct" />);
    expect(screen.getByText('You said')).toBeInTheDocument();

    rerender(<ProvenanceBadge provenance="inferred" />);
    expect(screen.getByText('Inferred')).toBeInTheDocument();

    rerender(<ProvenanceBadge provenance="synthesised" />);
    expect(screen.getByText('Synthesised')).toBeInTheDocument();

    rerender(<ProvenanceBadge provenance="refined" />);
    expect(screen.getByText('Refined')).toBeInTheDocument();
  });

  it('renders nothing when provenance is null', () => {
    const { container } = render(<ProvenanceBadge provenance={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
