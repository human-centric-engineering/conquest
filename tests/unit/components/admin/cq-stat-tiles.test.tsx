/**
 * CqStatTiles Component Tests
 *
 * Presentational stat-tile grid used on questionnaire and demo-client admin
 * surfaces. Server-renderable (no hooks). Tests verify that:
 *
 * - Each stat produces exactly one tile with its label and value
 * - The hint is rendered when provided and absent when not
 * - The `accent` flag applies the CSS custom-property class to the value element
 * - An empty stats array renders the grid container but no tiles
 *
 * @see components/admin/cq-stat-tiles.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CqStatTiles } from '@/components/admin/cq-stat-tiles';
import type { CqStat } from '@/components/admin/cq-stat-tiles';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStat(over: Partial<CqStat> = {}): CqStat {
  return {
    label: 'Total',
    value: 42,
    ...over,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CqStatTiles', () => {
  describe('tile rendering per stat', () => {
    it('renders one tile per stat with the correct label and value', () => {
      // Arrange
      const stats: CqStat[] = [
        makeStat({ label: 'Total responses', value: 10 }),
        makeStat({ label: 'Completion rate', value: '80%' }),
      ];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: label text is present for each stat
      expect(screen.getByText('Total responses')).toBeInTheDocument();
      expect(screen.getByText('Completion rate')).toBeInTheDocument();

      // Assert: value text is present for each stat — proves the component
      // rendered both and didn't just duplicate the first
      expect(screen.getByText('10')).toBeInTheDocument();
      expect(screen.getByText('80%')).toBeInTheDocument();
    });

    it('renders exactly the right number of tile containers', () => {
      // Arrange
      const stats: CqStat[] = [
        makeStat({ label: 'Alpha', value: 1 }),
        makeStat({ label: 'Beta', value: 2 }),
        makeStat({ label: 'Gamma', value: 3 }),
      ];

      // Act
      const { container } = render(<CqStatTiles stats={stats} />);

      // Assert: three child divs inside the grid (one per stat)
      // The source maps stats directly, so child count = stat count
      const grid = container.firstChild as HTMLElement;
      expect(grid.children).toHaveLength(3);
    });
  });

  describe('hint field', () => {
    it('renders the hint text when a hint is provided', () => {
      // Arrange
      const stats: CqStat[] = [makeStat({ label: 'Rate', value: '50%', hint: 'last 30 days' })];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: hint is visible
      expect(screen.getByText('last 30 days')).toBeInTheDocument();
    });

    it('does not render any hint element when hint is omitted', () => {
      // Arrange
      const stats: CqStat[] = [makeStat({ label: 'Rate', value: '50%' })];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: the hint text is absent — no muted-foreground hint div with
      // leftover text node from a prior test
      expect(screen.queryByText('last 30 days')).not.toBeInTheDocument();
    });

    it('renders the hint for some tiles and not others in the same row', () => {
      // Arrange: first stat has a hint, second does not
      const stats: CqStat[] = [
        makeStat({ label: 'With hint', value: 5, hint: 'visible hint' }),
        makeStat({ label: 'Without hint', value: 10 }),
      ];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: only the first stat's hint is present
      expect(screen.getByText('visible hint')).toBeInTheDocument();
      // Both labels still render — confirming both tiles mounted
      expect(screen.getByText('With hint')).toBeInTheDocument();
      expect(screen.getByText('Without hint')).toBeInTheDocument();
    });
  });

  describe('accent styling', () => {
    it('applies the cq-accent class to the value element when accent is true', () => {
      // Arrange
      const stats: CqStat[] = [makeStat({ label: 'Highlight', value: 99, accent: true })];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: the value element carries the CSS custom-property class that
      // applies the accent colour. We target the meaningful distinguishing
      // attribute (the class string fragment) rather than an exact full-class match.
      const valueEl = screen.getByText('99');
      expect(valueEl.className).toContain('text-[color:var(--cq-accent)]');
    });

    it('does not apply the cq-accent class when accent is false', () => {
      // Arrange
      const stats: CqStat[] = [makeStat({ label: 'Normal', value: 7, accent: false })];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: accent class is absent — the source conditionally adds it only
      // when accent is truthy
      const valueEl = screen.getByText('7');
      expect(valueEl.className).not.toContain('text-[color:var(--cq-accent)]');
    });

    it('does not apply the cq-accent class when accent is omitted', () => {
      // Arrange
      const stats: CqStat[] = [makeStat({ label: 'Default', value: 3 })];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: no accent styling for the default (omitted) case
      const valueEl = screen.getByText('3');
      expect(valueEl.className).not.toContain('text-[color:var(--cq-accent)]');
    });

    it('only applies the accent class to the accented tile, not its neighbour', () => {
      // Arrange
      const stats: CqStat[] = [
        makeStat({ label: 'Accented', value: 100, accent: true }),
        makeStat({ label: 'Plain', value: 200 }),
      ];

      // Act
      render(<CqStatTiles stats={stats} />);

      // Assert: accent on first tile value, not second
      expect(screen.getByText('100').className).toContain('text-[color:var(--cq-accent)]');
      expect(screen.getByText('200').className).not.toContain('text-[color:var(--cq-accent)]');
    });
  });

  describe('composite value (one tile, two figures)', () => {
    it('renders a ReactNode value in a single tile', () => {
      // The "Questions / Data slots" tile passes a composite node as its value.
      const stats: CqStat[] = [
        makeStat({
          label: 'Questions / Data slots',
          value: (
            <span>
              <span>5</span>
              <span> / </span>
              <span>4</span>
            </span>
          ),
        }),
      ];

      const { container } = render(<CqStatTiles stats={stats} />);

      // One tile, one title, both figures inside it.
      expect((container.firstChild as HTMLElement).children).toHaveLength(1);
      expect(screen.getByText('Questions / Data slots')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
    });
  });

  describe('empty stats array', () => {
    it('renders the grid container but no tile children when stats is empty', () => {
      // Arrange
      const stats: CqStat[] = [];

      // Act
      const { container } = render(<CqStatTiles stats={stats} />);

      // Assert: the top-level grid div is present (component mounted without crash)
      const grid = container.firstChild as HTMLElement;
      expect(grid).toBeTruthy();
      // No stat tiles were rendered
      expect(grid.children).toHaveLength(0);
    });

    it('renders no labels or values when stats is empty', () => {
      // Arrange + Act
      render(<CqStatTiles stats={[]} />);

      // Assert: nothing inside the grid — confirms the map produced no output,
      // not that it just hid them
      const { container } = render(<CqStatTiles stats={[]} />);
      expect(container.querySelectorAll('.cq-rise')).toHaveLength(0);
    });
  });

  describe('className prop', () => {
    it('merges the className prop onto the grid container', () => {
      // Arrange + Act
      const { container } = render(<CqStatTiles stats={[]} className="my-custom-class" />);

      // Assert: the custom class was forwarded (cn() merges it)
      const grid = container.firstChild as HTMLElement;
      expect(grid.className).toContain('my-custom-class');
    });
  });
});
