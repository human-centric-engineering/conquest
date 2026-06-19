/**
 * ReasoningTrace — per-turn "watch it think" disclosure for the respondent chat (demo feature).
 *
 * Test Coverage:
 * - Renders a compact "Reasoning · N" chip whose count comes from the steps array.
 * - Default (no `autoReveal`): mounts CLOSED (`aria-expanded="false"`); a click toggles it open,
 *   a second click closes it.
 * - `autoReveal` (the "Animated" placement, newest turn): mounts OPEN and auto-collapses after
 *   AUTO_REVEAL_DWELL_MS; the respondent can still re-open by clicking.
 * - The step rows stay mounted regardless of open/closed state (the collapse is an animated CSS
 *   grid-rows transition, not a DOM unmount) — so open/closed is asserted via `aria-expanded`,
 *   not text presence.
 * - Each ReasoningStepKind renders its step label; empty steps array renders nothing (null).
 * - Optional affordances: confidence pips (with band aria-label); `detail` / `rationale` /
 *   `sourceQuote` render conditionally; tone variants render without crashing.
 *
 * @see components/app/questionnaire/chat/reasoning-trace.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ReasoningTrace,
  AUTO_REVEAL_DWELL_MS,
  AUTO_REVEAL_PER_ITEM_MS,
  AUTO_REVEAL_ITEM_THRESHOLD,
  computeReasoningDwellMs,
} from '@/components/app/questionnaire/chat/reasoning-trace';
import type { ReasoningStep, ReasoningStepKind } from '@/lib/app/questionnaire/reasoning';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    kind: 'extraction',
    label: 'Captured answer',
    tone: 'neutral',
    ...overrides,
  };
}

const ALL_KINDS: ReasoningStepKind[] = [
  'extraction',
  'contradiction',
  'refinement',
  'completion',
  'selection',
];

// ---------------------------------------------------------------------------
// Empty steps
// ---------------------------------------------------------------------------

describe('ReasoningTrace — empty steps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when steps is an empty array (default)', () => {
    // Arrange / Act
    const { container } = render(<ReasoningTrace steps={[]} />);

    // Assert: no chip, no button, no list.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when steps is an empty array even with autoReveal', () => {
    // Arrange / Act
    const { container } = render(<ReasoningTrace steps={[]} autoReveal />);

    // Assert: still null — the auto-reveal timer is harmless when there is nothing to show.
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The chip + default (closed) behaviour
// ---------------------------------------------------------------------------

describe('ReasoningTrace — chip + default closed state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the "Reasoning · N" chip button showing step count', () => {
    // Arrange
    const steps = [makeStep(), makeStep({ kind: 'selection' }), makeStep({ kind: 'completion' })];

    // Act
    render(<ReasoningTrace steps={steps} />);

    // Assert: the chip text shows the count the component computed from the steps array.
    expect(screen.getByRole('button', { name: /reasoning/i })).toBeInTheDocument();
    expect(screen.getByText('Reasoning · 3')).toBeInTheDocument();
  });

  it('starts closed — aria-expanded="false" without autoReveal', () => {
    // Arrange / Act
    render(<ReasoningTrace steps={[makeStep()]} />);

    // Assert: the disclosure is collapsed by default (the quiet "Inline" placement).
    expect(screen.getByRole('button', { name: /reasoning/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens on click and closes again on a second click', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<ReasoningTrace steps={[makeStep()]} />);
    const btn = screen.getByRole('button', { name: /reasoning/i });

    // Act + Assert: first click opens.
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Act + Assert: second click closes.
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps step rows mounted regardless of open/closed (animated collapse, not unmount)', () => {
    // Arrange: closed by default — but the rows are still in the DOM so the collapse can animate.
    render(<ReasoningTrace steps={[makeStep({ label: 'Always mounted label' })]} />);

    // Assert: the label is present even while collapsed (visibility is a CSS concern here).
    expect(screen.getByText('Always mounted label')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reasoning/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('hides the always-mounted rows from assistive tech while collapsed, reveals them when open', async () => {
    // The rows stay in the DOM (so the grid-rows collapse can animate), so the collapsed content
    // must carry aria-hidden/inert — otherwise a screen reader reads every step while the chip
    // reports aria-expanded="false". The button's aria-controls points at the content region.
    const user = userEvent.setup();
    render(<ReasoningTrace steps={[makeStep({ label: 'Hidden-while-closed label' })]} />);

    const btn = screen.getByRole('button', { name: /reasoning/i });
    const content = document.getElementById(btn.getAttribute('aria-controls') ?? '');
    expect(content).not.toBeNull();

    // Closed: content is hidden from AT.
    expect(content).toHaveAttribute('aria-hidden', 'true');

    // Open: content is exposed to AT.
    await user.click(btn);
    expect(content).not.toHaveAttribute('aria-hidden', 'true');
  });
});

// ---------------------------------------------------------------------------
// autoReveal — the "Animated" placement, newest turn
// ---------------------------------------------------------------------------

describe('ReasoningTrace — autoReveal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mounts OPEN when autoReveal is set', () => {
    // Arrange: fake timers so the auto-collapse setTimeout never fires for real and can't leak
    // into a sibling test (afterEach restores real timers).
    vi.useFakeTimers();

    // Act
    render(<ReasoningTrace steps={[makeStep()]} autoReveal />);

    // Assert: the newest turn's reasoning is shown immediately.
    expect(screen.getByRole('button', { name: /reasoning/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('auto-collapses after AUTO_REVEAL_DWELL_MS', () => {
    // Arrange: fake timers so we can advance past the dwell deterministically.
    vi.useFakeTimers();
    render(<ReasoningTrace steps={[makeStep()]} autoReveal />);
    const btn = screen.getByRole('button', { name: /reasoning/i });
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Act: advance past the dwell.
    act(() => {
      vi.advanceTimersByTime(AUTO_REVEAL_DWELL_MS);
    });

    // Assert: it tucked itself away.
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('does NOT auto-collapse before the dwell elapses', () => {
    // Arrange
    vi.useFakeTimers();
    render(<ReasoningTrace steps={[makeStep()]} autoReveal />);
    const btn = screen.getByRole('button', { name: /reasoning/i });

    // Act: advance to just before the dwell.
    act(() => {
      vi.advanceTimersByTime(AUTO_REVEAL_DWELL_MS - 1);
    });

    // Assert: still open.
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('lets the respondent re-open after the auto-collapse', () => {
    // Arrange: advance past the dwell so it has closed itself.
    vi.useFakeTimers();
    render(<ReasoningTrace steps={[makeStep()]} autoReveal />);
    const btn = screen.getByRole('button', { name: /reasoning/i });
    act(() => {
      vi.advanceTimersByTime(AUTO_REVEAL_DWELL_MS);
    });
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    // Act: a manual click re-opens (fireEvent under fake timers — no userEvent async clock).
    act(() => {
      btn.click();
    });

    // Assert
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('auto-collapses at a custom dwellMs rather than the default', () => {
    // The dwell is now per-turn (sized to the step count); the component honours the prop.
    vi.useFakeTimers();
    render(<ReasoningTrace steps={[makeStep()]} autoReveal dwellMs={2660} />);
    const btn = screen.getByRole('button', { name: /reasoning/i });

    // Still open at the default dwell — the custom dwell is longer.
    act(() => {
      vi.advanceTimersByTime(AUTO_REVEAL_DWELL_MS);
    });
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Closes once the custom dwell elapses.
    act(() => {
      vi.advanceTimersByTime(2660 - AUTO_REVEAL_DWELL_MS);
    });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});

// ---------------------------------------------------------------------------
// computeReasoningDwellMs — dwell scales with step count
// ---------------------------------------------------------------------------

describe('computeReasoningDwellMs', () => {
  it('returns the base dwell for up to the threshold (two) steps', () => {
    expect(computeReasoningDwellMs(0)).toBe(AUTO_REVEAL_DWELL_MS);
    expect(computeReasoningDwellMs(1)).toBe(AUTO_REVEAL_DWELL_MS);
    expect(computeReasoningDwellMs(AUTO_REVEAL_ITEM_THRESHOLD)).toBe(AUTO_REVEAL_DWELL_MS);
  });

  it('adds the per-item dwell for each step beyond the threshold', () => {
    expect(computeReasoningDwellMs(3)).toBe(AUTO_REVEAL_DWELL_MS + AUTO_REVEAL_PER_ITEM_MS);
    expect(computeReasoningDwellMs(5)).toBe(AUTO_REVEAL_DWELL_MS + 3 * AUTO_REVEAL_PER_ITEM_MS);
  });

  it('uses the supplied base and per-item overrides (the admin-tunable config)', () => {
    // 4 steps → base 3000 + (4 - 2) * 500 = 4000
    expect(computeReasoningDwellMs(4, 3000, 500)).toBe(4000);
    // At/under threshold → exactly the base, no per-item applied
    expect(computeReasoningDwellMs(2, 3000, 500)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// All ReasoningStepKind values render without crashing
// ---------------------------------------------------------------------------

describe('ReasoningTrace — each ReasoningStepKind', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const kind of ALL_KINDS) {
    it(`renders the step label for kind="${kind}"`, () => {
      // Arrange: rows are always mounted, so the label is present without a click.
      const label = `Label for ${kind}`;
      const steps = [makeStep({ kind, label })];

      // Act
      render(<ReasoningTrace steps={steps} />);

      // Assert: the step label produced by the component (not the input array) is in the DOM.
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }
});

// ---------------------------------------------------------------------------
// Tone variants
// ---------------------------------------------------------------------------

describe('ReasoningTrace — tone variants', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a step with tone="neutral" without crashing', () => {
    render(<ReasoningTrace steps={[makeStep({ tone: 'neutral', label: 'Neutral step' })]} />);
    expect(screen.getByText('Neutral step')).toBeInTheDocument();
  });

  it('renders a step with tone="insight" without crashing', () => {
    render(<ReasoningTrace steps={[makeStep({ tone: 'insight', label: 'Insight step' })]} />);
    expect(screen.getByText('Insight step')).toBeInTheDocument();
  });

  it('renders a step with tone="caution" without crashing', () => {
    render(<ReasoningTrace steps={[makeStep({ tone: 'caution', label: 'Caution step' })]} />);
    expect(screen.getByText('Caution step')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Optional affordances — detail, rationale, sourceQuote, confidence
// ---------------------------------------------------------------------------

describe('ReasoningTrace — optional affordances', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders step.detail when present', () => {
    render(<ReasoningTrace steps={[makeStep({ detail: 'Some supporting detail text' })]} />);
    expect(screen.getByText('Some supporting detail text')).toBeInTheDocument();
  });

  it('does NOT render a detail/rationale/quote paragraph when those are absent', () => {
    // Arrange: only a label — the label is a <span>, so there should be no <p> elements at all.
    render(<ReasoningTrace steps={[makeStep({ label: 'Only a label' })]} />);

    // Assert
    expect(screen.getByText('Only a label')).toBeInTheDocument();
    expect(document.querySelectorAll('p').length).toBe(0);
  });

  it('renders step.rationale when present', () => {
    render(
      <ReasoningTrace steps={[makeStep({ rationale: 'Because the respondent implied it.' })]} />
    );
    expect(screen.getByText('Because the respondent implied it.')).toBeInTheDocument();
  });

  it('renders step.sourceQuote wrapped in typographic quotes when present', () => {
    // Arrange: the component wraps the source quote in curly quotes (U+201C / U+201D).
    render(<ReasoningTrace steps={[makeStep({ sourceQuote: 'I earn about 50k a year' })]} />);

    // Assert: the quote text is rendered inside a paragraph, wrapped in curly quotes. The JSX is
    // `"{step.sourceQuote}"` (three text nodes), so match against the paragraph's textContent.
    const paragraph = screen.getByText((_, element) => {
      if (!element || element.tagName !== 'P') return false;
      return (element.textContent ?? '').includes('I earn about 50k a year');
    });
    expect(paragraph).toBeInTheDocument();
    expect(paragraph.textContent).toMatch(/“.*”/);
  });

  // Pip bands derive from the canonical confidenceBand (high ≥0.85, moderate ≥0.6, low <0.6),
  // so the trace's aria-label matches the answer-panel confidence chip.
  it('renders high confidence pips with a band aria-label', () => {
    render(<ReasoningTrace steps={[makeStep({ confidence: 0.9, label: 'High step' })]} />);
    expect(screen.getByLabelText(/high confidence/i)).toBeInTheDocument();
  });

  it('renders moderate confidence pips when confidence is 0.6', () => {
    render(<ReasoningTrace steps={[makeStep({ confidence: 0.6, label: 'Moderate step' })]} />);
    expect(screen.getByLabelText(/moderate confidence/i)).toBeInTheDocument();
  });

  it('renders low confidence pips when confidence is 0.3', () => {
    render(<ReasoningTrace steps={[makeStep({ confidence: 0.3, label: 'Low step' })]} />);
    expect(screen.getByLabelText(/low confidence/i)).toBeInTheDocument();
  });

  it('does NOT render confidence pips when confidence is absent', () => {
    render(<ReasoningTrace steps={[makeStep({ label: 'No confidence step' })]} />);
    expect(screen.queryByLabelText(/confidence/i)).toBeNull();
  });
});
