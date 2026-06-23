/**
 * ConfidenceScore Tests
 *
 * Covers: null renders nothing, each confidence band (high/moderate/low) renders
 * the correct label and percentage, boundary values between bands, the `title`
 * attribute format, and the optional className forwarding.
 *
 * Band thresholds (from lib/app/questionnaire/panel/confidence.ts):
 *   ≥ 0.85 → high      ("Confident")
 *   ≥ 0.65 → moderate  ("Fairly sure")
 *   ≥ 0.45 → tentative ("Tentative")
 *   < 0.45 → low       ("Unsure")
 *
 * @see components/app/questionnaire/panel/confidence-score.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';

describe('ConfidenceScore', () => {
  describe('renders nothing when confidence is unscored', () => {
    it('returns null when confidence is null', () => {
      const { container } = render(<ConfidenceScore confidence={null} />);

      // Assert: no DOM output — confidencePercent(null) returns null and the
      // component short-circuits before rendering the chip.
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('high band (confidence ≥ 0.85)', () => {
    it('renders "Confident" label at 0.85 (lower boundary)', () => {
      render(<ConfidenceScore confidence={0.85} />);

      // Assert: the component used confidenceBandLabel to produce "Confident",
      // not a mock return — we verify the rendered text exists.
      expect(screen.getByText(/Confident/)).toBeInTheDocument();
    });

    it('renders the correct percentage at the lower boundary (0.85 → 85%)', () => {
      render(<ConfidenceScore confidence={0.85} />);
      expect(screen.getByText(/85%/)).toBeInTheDocument();
    });

    it('renders "Confident" label with emerald tint at 0.95', () => {
      render(<ConfidenceScore confidence={0.95} />);
      const chip = screen.getByText(/Confident/);
      // The chip renders as a <span>; check the parent element for the band class.
      const span = chip.closest('span');
      expect(span).not.toBeNull();
      expect(span!.className).toContain('emerald');
    });

    it('renders the correct percentage at 0.95 (95%)', () => {
      render(<ConfidenceScore confidence={0.95} />);
      expect(screen.getByText(/95%/)).toBeInTheDocument();
    });

    it('renders "Confident" and "100%" at 1.0 (maximum)', () => {
      render(<ConfidenceScore confidence={1.0} />);
      expect(screen.getByText(/Confident/)).toBeInTheDocument();
      expect(screen.getByText(/100%/)).toBeInTheDocument();
    });
  });

  describe('moderate band (0.65 ≤ confidence < 0.85)', () => {
    it('renders "Fairly sure" label at 0.65 (lower boundary)', () => {
      render(<ConfidenceScore confidence={0.65} />);
      expect(screen.getByText(/Fairly sure/)).toBeInTheDocument();
    });

    it('renders the correct percentage at 0.65 (65%)', () => {
      render(<ConfidenceScore confidence={0.65} />);
      expect(screen.getByText(/65%/)).toBeInTheDocument();
    });

    it('renders "Fairly sure" with amber tint at 0.75', () => {
      render(<ConfidenceScore confidence={0.75} />);
      const chip = screen.getByText(/Fairly sure/);
      expect(chip.closest('span')!.className).toContain('amber');
    });

    it('renders "Fairly sure" at just below the high-band threshold (0.84)', () => {
      render(<ConfidenceScore confidence={0.84} />);
      expect(screen.getByText(/Fairly sure/)).toBeInTheDocument();
    });
  });

  describe('tentative band (0.45 ≤ confidence < 0.65)', () => {
    it('renders "Tentative" label at 0.45 (lower boundary)', () => {
      render(<ConfidenceScore confidence={0.45} />);
      expect(screen.getByText(/Tentative/)).toBeInTheDocument();
    });

    it('renders "Tentative" with orange tint at 0.6', () => {
      render(<ConfidenceScore confidence={0.6} />);
      const chip = screen.getByText(/Tentative/);
      expect(chip.closest('span')!.className).toContain('orange');
    });

    it('renders the correct percentage at 0.6 (60%)', () => {
      render(<ConfidenceScore confidence={0.6} />);
      expect(screen.getByText(/60%/)).toBeInTheDocument();
    });

    it('renders "Tentative" at just below the moderate threshold (0.64)', () => {
      render(<ConfidenceScore confidence={0.64} />);
      expect(screen.getByText(/Tentative/)).toBeInTheDocument();
    });
  });

  describe('low band (confidence < 0.45)', () => {
    it('renders "Unsure" label at 0.44 (just below tentative threshold)', () => {
      render(<ConfidenceScore confidence={0.44} />);
      expect(screen.getByText(/Unsure/)).toBeInTheDocument();
    });

    it('renders "Unsure" with red tint at 0.3', () => {
      render(<ConfidenceScore confidence={0.3} />);
      const chip = screen.getByText(/Unsure/);
      expect(chip.closest('span')!.className).toContain('red');
    });

    it('renders the correct percentage at 0.3 (30%)', () => {
      render(<ConfidenceScore confidence={0.3} />);
      expect(screen.getByText(/30%/)).toBeInTheDocument();
    });

    it('renders "Unsure" and "0%" at 0.0 (minimum scored)', () => {
      render(<ConfidenceScore confidence={0.0} />);
      expect(screen.getByText(/Unsure/)).toBeInTheDocument();
      expect(screen.getByText(/0%/)).toBeInTheDocument();
    });
  });

  describe('title attribute', () => {
    it('includes the band label in the title at 0.88', () => {
      render(<ConfidenceScore confidence={0.88} />);
      const chip = screen.getByText(/Confident/).closest('span');
      // title format: "{BandLabel} — {pct} confidence"
      expect(chip).toHaveAttribute('title', expect.stringContaining('Confident'));
    });

    it('includes the percentage in the title at 0.88', () => {
      render(<ConfidenceScore confidence={0.88} />);
      const chip = screen.getByText(/Confident/).closest('span');
      expect(chip).toHaveAttribute('title', expect.stringContaining('88%'));
    });
  });

  describe('optional className', () => {
    it('forwards className to the span chip', () => {
      render(<ConfidenceScore confidence={0.9} className="my-extra-class" />);
      const chip = screen.getByText(/Confident/).closest('span');
      expect(chip).toHaveClass('my-extra-class');
    });

    it('renders without error when className is omitted', () => {
      render(<ConfidenceScore confidence={0.9} />);
      expect(screen.getByText(/Confident/)).toBeInTheDocument();
    });
  });
});
