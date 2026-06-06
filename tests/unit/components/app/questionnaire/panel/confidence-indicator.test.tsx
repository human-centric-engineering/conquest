/**
 * ConfidenceIndicator — band label + colour per confidence (F7.2).
 *
 * @see components/app/questionnaire/panel/confidence-indicator.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';

describe('ConfidenceIndicator', () => {
  it('labels a high confidence "Confident" with the emerald tint', () => {
    render(<ConfidenceIndicator confidence={0.95} />);
    const dot = screen.getByRole('img', { name: 'Confident' });
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain('emerald');
  });

  it('labels a moderate confidence "Fairly sure" with the amber tint', () => {
    render(<ConfidenceIndicator confidence={0.7} />);
    expect(screen.getByRole('img', { name: 'Fairly sure' }).className).toContain('amber');
  });

  it('labels a low confidence "Unsure" with the red tint', () => {
    render(<ConfidenceIndicator confidence={0.3} />);
    expect(screen.getByRole('img', { name: 'Unsure' }).className).toContain('red');
  });

  it('labels a null (unscored) confidence "Captured" with the muted tint', () => {
    render(<ConfidenceIndicator confidence={null} />);
    expect(screen.getByRole('img', { name: 'Captured' }).className).toContain('muted');
  });
});
