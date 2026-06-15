/**
 * ReasoningTrace — live "watch it think" feed for the respondent chat (demo feature).
 *
 * Test Coverage:
 * - `live` variant: renders titled panel with role="status", "Working it through" heading,
 *   all step rows visible without needing a click.
 * - `collapsed` variant: renders a compact chip showing step count; starts closed; expands
 *   on click to reveal step rows; collapses on second click.
 * - Each ReasoningStepKind renders its step label inside the list (icon driven by STEP_ICONS map).
 * - Empty steps array renders nothing (null).
 * - Optional affordances: confidence pips render when `confidence` is present; `detail`,
 *   `rationale`, and `sourceQuote` render conditionally; they are absent when omitted.
 * - Tone variants: `neutral` / `insight` / `caution` all render without crashing.
 *
 * @see components/app/questionnaire/chat/reasoning-trace.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReasoningTrace } from '@/components/app/questionnaire/chat/reasoning-trace';
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

  it('renders nothing when steps is an empty array (live variant)', () => {
    // Arrange
    const { container } = render(<ReasoningTrace steps={[]} variant="live" />);

    // Assert: component returns null — nothing in the DOM.
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when steps is an empty array (collapsed variant)', () => {
    // Arrange
    const { container } = render(<ReasoningTrace steps={[]} variant="collapsed" />);

    // Assert: no chip, no button, no list.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live variant
// ---------------------------------------------------------------------------

describe('ReasoningTrace — live variant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a role="status" container with aria-label "Agent reasoning"', () => {
    // Arrange
    const steps = [makeStep({ label: 'Captured "What is your name?"' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: live panel uses polite status for screen readers.
    const panel = screen.getByRole('status', { name: /agent reasoning/i });
    expect(panel).toBeInTheDocument();
  });

  it('renders the "Working it through" heading', () => {
    // Arrange
    const steps = [makeStep()];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: the live panel clearly signals the agent is working.
    expect(screen.getByText('Working it through')).toBeInTheDocument();
  });

  it('renders step labels without requiring any interaction', () => {
    // Arrange: live mode is always open — rows appear immediately.
    const steps = [
      makeStep({ label: 'First step label' }),
      makeStep({ kind: 'selection', label: 'Second step label' }),
    ];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: both step labels are visible without a click.
    expect(screen.getByText('First step label')).toBeInTheDocument();
    expect(screen.getByText('Second step label')).toBeInTheDocument();
  });

  it('does NOT render the collapsed chip button', () => {
    // Arrange
    const steps = [makeStep()];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: no "Reasoning · N" chip exists in live mode.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('accepts an optional className without crashing', () => {
    // Arrange
    const steps = [makeStep()];

    // Act — no assertion on className applied (presentational only), just verify no crash.
    const { container } = render(
      <ReasoningTrace steps={steps} variant="live" className="custom-class" />
    );

    // Assert: component still renders its container.
    expect(container.firstChild).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Collapsed variant
// ---------------------------------------------------------------------------

describe('ReasoningTrace — collapsed variant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the "Reasoning · N" chip button showing step count', () => {
    // Arrange
    const steps = [makeStep(), makeStep({ kind: 'selection' }), makeStep({ kind: 'completion' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);

    // Assert: the chip text shows the count the component computed from the steps array.
    expect(screen.getByRole('button', { name: /reasoning/i })).toBeInTheDocument();
    expect(screen.getByText('Reasoning · 3')).toBeInTheDocument();
  });

  it('starts collapsed — step rows are NOT visible before any click', () => {
    // Arrange
    const steps = [makeStep({ label: 'Hidden step label' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);

    // Assert: no list items visible initially — collapsed by default.
    expect(screen.queryByText('Hidden step label')).toBeNull();
  });

  it('has aria-expanded="false" on the chip button when closed', () => {
    // Arrange
    const steps = [makeStep()];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);

    // Assert: ARIA state matches the visual state (collapsed).
    const btn = screen.getByRole('button', { name: /reasoning/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to show step rows when the chip is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    const steps = [makeStep({ label: 'Visible after click' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);
    await user.click(screen.getByRole('button', { name: /reasoning/i }));

    // Assert: the step label is now in the DOM — the component revealed the list.
    expect(screen.getByText('Visible after click')).toBeInTheDocument();
  });

  it('has aria-expanded="true" on the chip button when open', async () => {
    // Arrange
    const user = userEvent.setup();
    const steps = [makeStep()];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);
    await user.click(screen.getByRole('button', { name: /reasoning/i }));

    // Assert: ARIA state updated to reflect expanded state.
    expect(screen.getByRole('button', { name: /reasoning/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('collapses again on a second click — hides step rows', async () => {
    // Arrange
    const user = userEvent.setup();
    const steps = [makeStep({ label: 'Will disappear again' })];

    // Act: expand then collapse.
    render(<ReasoningTrace steps={steps} variant="collapsed" />);
    await user.click(screen.getByRole('button', { name: /reasoning/i }));
    await user.click(screen.getByRole('button', { name: /reasoning/i }));

    // Assert: step row hidden again after second click.
    expect(screen.queryByText('Will disappear again')).toBeNull();
    expect(screen.getByRole('button', { name: /reasoning/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('shows all step labels when expanded with multiple steps', async () => {
    // Arrange
    const user = userEvent.setup();
    const steps = [
      makeStep({ label: 'Step one label' }),
      makeStep({ kind: 'contradiction', label: 'Step two label' }),
    ];

    // Act
    render(<ReasoningTrace steps={steps} variant="collapsed" />);
    await user.click(screen.getByRole('button', { name: /reasoning/i }));

    // Assert: all step labels rendered — the list has both rows.
    expect(screen.getByText('Step one label')).toBeInTheDocument();
    expect(screen.getByText('Step two label')).toBeInTheDocument();
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
    it(`renders the step label for kind="${kind}"`, async () => {
      // Arrange: use live variant so steps are always visible (no click needed).
      const label = `Label for ${kind}`;
      const steps = [makeStep({ kind, label })];

      // Act
      render(<ReasoningTrace steps={steps} variant="live" />);

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
    // Arrange
    const steps = [makeStep({ tone: 'neutral', label: 'Neutral step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: the label is rendered — tone difference is stylistic, not structural.
    expect(screen.getByText('Neutral step')).toBeInTheDocument();
  });

  it('renders a step with tone="insight" without crashing', () => {
    // Arrange
    const steps = [makeStep({ tone: 'insight', label: 'Insight step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert
    expect(screen.getByText('Insight step')).toBeInTheDocument();
  });

  it('renders a step with tone="caution" without crashing', () => {
    // Arrange
    const steps = [makeStep({ tone: 'caution', label: 'Caution step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert
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
    // Arrange
    const steps = [makeStep({ detail: 'Some supporting detail text' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: the detail paragraph is rendered below the headline.
    expect(screen.getByText('Some supporting detail text')).toBeInTheDocument();
  });

  it('does NOT render a detail element when step.detail is absent', () => {
    // Arrange: no detail property.
    const steps = [makeStep({ label: 'Only a label' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: only the label is present, no extra paragraph.
    expect(screen.getByText('Only a label')).toBeInTheDocument();
    // detail text is undefined so we can't query for it; verify count of paragraphs via container.
    const paragraphs = document.querySelectorAll('p');
    expect(paragraphs.length).toBe(0);
  });

  it('renders step.rationale when present', () => {
    // Arrange
    const steps = [makeStep({ rationale: 'Because the respondent implied it.' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: rationale text is visible.
    expect(screen.getByText('Because the respondent implied it.')).toBeInTheDocument();
  });

  it('renders step.sourceQuote wrapped in quotes when present', () => {
    // Arrange: the component wraps the source quote in typographic quotes.
    const steps = [makeStep({ sourceQuote: 'I earn about 50k a year' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: the component emits the quote text inside a paragraph.
    // The JSX is: `"{step.sourceQuote}"` — three text nodes rendered by React, so RTL's
    // getByText regex tries to match the `textContent` of a single element that joins them.
    // Use a string matcher against the paragraph's combined textContent.
    const paragraph = screen.getByText((_, element) => {
      if (!element || element.tagName !== 'P') return false;
      return (element.textContent ?? '').includes('I earn about 50k a year');
    });
    expect(paragraph).toBeInTheDocument();
    // The component renders curly left/right quotes (U+201C / U+201D) around the sourceQuote.
    expect(paragraph.textContent).toMatch(/“.*”/);
  });

  it('does NOT render a sourceQuote paragraph when sourceQuote is absent', () => {
    // Arrange
    const steps = [makeStep({ label: 'No quote step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: nothing that looks like a quoted span in the DOM.
    const allText = document.body.textContent ?? '';
    expect(allText).not.toContain('"');
  });

  // Pip bands derive from the canonical confidenceBand (high ≥0.85, moderate ≥0.6, low <0.6),
  // so the trace's aria-label matches the answer-panel confidence chip.
  it('renders confidence pips with aria-label when step.confidence is present', () => {
    // Arrange: confidence 0.9 → band 'high' → 3 pips → "high confidence"
    const steps = [makeStep({ confidence: 0.9, label: 'High-confidence step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: the ConfidencePips span has an aria-label that names the band.
    expect(screen.getByLabelText(/high confidence/i)).toBeInTheDocument();
  });

  it('renders moderate confidence pips when confidence is 0.6', () => {
    // Arrange: 0.6 ≥ 0.6 → band 'moderate' → level 2 → "moderate confidence"
    const steps = [makeStep({ confidence: 0.6, label: 'Moderate-confidence step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert
    expect(screen.getByLabelText(/moderate confidence/i)).toBeInTheDocument();
  });

  it('renders low confidence pips when confidence is 0.3', () => {
    // Arrange: 0.3 < 0.6 → band 'low' → level 1 → "low confidence"
    const steps = [makeStep({ confidence: 0.3, label: 'Low-confidence step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert
    expect(screen.getByLabelText(/low confidence/i)).toBeInTheDocument();
  });

  it('does NOT render confidence pips when confidence is absent', () => {
    // Arrange: no confidence property.
    const steps = [makeStep({ label: 'No confidence step' })];

    // Act
    render(<ReasoningTrace steps={steps} variant="live" />);

    // Assert: no element with a confidence-related aria-label in the DOM.
    expect(screen.queryByLabelText(/confidence/i)).toBeNull();
  });
});
