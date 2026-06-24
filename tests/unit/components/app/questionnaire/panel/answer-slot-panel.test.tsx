/**
 * AnswerSlotPanel (+ AnswerSlotItem) — rendering, scope header, expand, Revisit (F7.2).
 *
 * @see components/app/questionnaire/panel/answer-slot-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

function answeredSlot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'role',
    prompt: 'What is your role?',
    type: 'free_text',
    typeConfig: null,
    required: true,
    answered: true,
    value: 'Engineer',
    provenance: 'direct',
    confidence: 0.9,
    rationale: 'Stated directly.',
    answeredAtTurnIndex: 1,
    refinementHistory: [],
    ...over,
  };
}

function pendingSlot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'team',
    prompt: 'How big is your team?',
    type: 'numeric',
    typeConfig: null,
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

function filledDataSlot(over: Partial<DataSlotPanelSlot> = {}): DataSlotPanelSlot {
  return {
    key: 'strategy',
    name: 'Strategy',
    description: 'Their strategic priorities.',
    paraphrase: 'Focused on restructuring go-to-market.',
    provenance: 'direct',
    confidence: 0.58,
    rationale: null,
    filled: true,
    provisional: false,
    answeredAtTurnIndex: 1,
    history: [],
    coverage: { total: 0, answered: 0, questions: [] },
    ...over,
  };
}

function view(over: Partial<AnswerPanelView> = {}): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [{ sectionId: 's1', title: 'About you', slots: [answeredSlot(), pendingSlot()] }],
    answeredCount: 1,
    totalCount: 2,
    ...over,
  };
}

describe('AnswerSlotPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a loading message when view is null and loading', () => {
    render(<AnswerSlotPanel view={null} loading />);
    expect(screen.getByText(/Loading your answers/)).toBeInTheDocument();
  });

  it('shows "No answers yet." when view is null and not loading', () => {
    render(<AnswerSlotPanel view={null} />);
    expect(screen.getByText('No answers yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Loading your answers/)).not.toBeInTheDocument();
  });

  it('shows the X-of-N progress header in full_progress', () => {
    render(<AnswerSlotPanel view={view()} />);
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument();
  });

  it('shows the captured count header in answered_only', () => {
    render(
      <AnswerSlotPanel
        view={view({
          scope: 'answered_only',
          sections: [{ sectionId: 's1', title: 'About you', slots: [answeredSlot()] }],
        })}
      />
    );
    expect(screen.getByText('1 captured')).toBeInTheDocument();
  });

  it('shows the captured-context header + first-turn explainer, never a percentage, in data-slot mode', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [{ theme: 'Strategy', slots: [] }],
          progressPercent: 37,
          // Background question counts are still present but must NOT be shown to the respondent.
          answeredCount: 0,
          totalCount: 71,
        })}
      />
    );
    expect(screen.getByText('Capturing your context')).toBeInTheDocument();
    // The panel no longer carries its own percentage/bar — the labelled questionnaire bar up top
    // owns "% complete", so nothing here reads as a second completion meter.
    expect(screen.queryByText('37% complete')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('0 of 71 answered')).not.toBeInTheDocument();
    // First turn (nothing captured): the background-fill explainer is shown in full.
    expect(
      screen.getByText(/filling out your questionnaire in the background/i)
    ).toBeInTheDocument();
  });

  it('appends average confidence to the header when present (question mode)', () => {
    render(<AnswerSlotPanel view={view({ averageConfidence: 0.9 })} />);
    // Completion and the rounded average are shown together on one line.
    expect(screen.getByText('1 of 2 answered · avg confidence 90%')).toBeInTheDocument();
  });

  it('shows captured-of-total context areas and average confidence in data-slot mode', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [
            {
              theme: 'Strategy',
              slots: [filledDataSlot(), filledDataSlot({ key: 'pricing', filled: false })],
            },
          ],
          progressPercent: 37,
          averageConfidence: 0.58,
          answeredCount: 0,
          totalCount: 71,
        })}
      />
    );
    // Captured count over the total number of context areas, paired with confidence — no percentage.
    expect(
      screen.getByText('1 of 2 context areas captured with 58% confidence')
    ).toBeInTheDocument();
  });

  it('folds the explainer behind a "How this works" disclosure once context is captured', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [{ theme: 'Strategy', slots: [filledDataSlot()] }],
          progressPercent: 37,
          answeredCount: 0,
          totalCount: 71,
        })}
      />
    );
    // The explainer text is still in the DOM (inside <details>) but the toggle is present.
    expect(screen.getByText('How this works')).toBeInTheDocument();
    expect(
      screen.getByText(/filling out your questionnaire in the background/i)
    ).toBeInTheDocument();
  });

  it('omits the average-confidence suffix when none is scored yet', () => {
    render(<AnswerSlotPanel view={view()} />);
    // No averageConfidence on the view → header is the bare completion string.
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument();
    expect(screen.queryByText(/avg confidence/)).not.toBeInTheDocument();
  });

  it('shows the current data-slot paraphrase and prior values as "Earlier:" history', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [
            {
              theme: 'Demographics',
              slots: [
                {
                  key: 'demographics',
                  name: 'Employee Demographics',
                  description: 'Age + gender',
                  paraphrase: 'A 25-year-old female.',
                  provenance: 'direct',
                  confidence: 0.95,
                  rationale: 'They stated their age and corrected their gender.',
                  filled: true,
                  provisional: false,
                  answeredAtTurnIndex: 2,
                  history: [{ paraphrase: 'A 25-year-old male.', confidence: 0.9 }],
                  coverage: { total: 0, answered: 0, questions: [] },
                },
              ],
            },
          ],
          progressPercent: 20,
        })}
      />
    );
    expect(screen.getByText('A 25-year-old female.')).toBeInTheDocument();
    expect(screen.getByText('Earlier: A 25-year-old male.')).toBeInTheDocument();
  });

  it('marks a provisional data slot as "provisional · may revisit"', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [
            {
              theme: 'Wellbeing',
              slots: [
                {
                  key: 'blockers',
                  name: 'Workplace Blockers',
                  description: 'What gets in the way',
                  paraphrase: 'A tentative reading of what slows them down.',
                  provenance: 'synthesised',
                  confidence: 0.2,
                  rationale: null,
                  filled: true,
                  provisional: true,
                  answeredAtTurnIndex: 1,
                  history: [],
                  coverage: { total: 0, answered: 0, questions: [] },
                },
              ],
            },
          ],
          progressPercent: 30,
        })}
      />
    );
    expect(screen.getByText('A tentative reading of what slows them down.')).toBeInTheDocument();
    expect(screen.getByText(/provisional · may revisit/i)).toBeInTheDocument();
  });

  it('shows the "Inferred" marker and confidence score for an inferred-provenance slot (still uncovered)', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [
            {
              theme: 'Wellbeing',
              slots: [
                {
                  key: 'blockers',
                  name: 'Work Blockers',
                  description: 'What gets in the way',
                  paraphrase: 'They may be feeling blocked in their role.',
                  provenance: 'inferred',
                  confidence: 0.3,
                  rationale: 'Read from their frustration about management.',
                  filled: false,
                  provisional: false,
                  answeredAtTurnIndex: null,
                  history: [],
                  coverage: { total: 0, answered: 0, questions: [] },
                },
              ],
            },
          ],
          progressPercent: 25,
        })}
      />
    );
    // The reading is shown (low-confidence inferences stay visible) but clearly marked as inferred,
    // with the actual confidence score surfaced as a chip.
    expect(screen.getByText('They may be feeling blocked in their role.')).toBeInTheDocument();
    expect(screen.getByText('Inferred')).toBeInTheDocument();
    expect(screen.getByText(/Unsure · 30%/)).toBeInTheDocument();
  });

  it('does not mark a directly-stated data-slot fill as inferred', () => {
    render(
      <AnswerSlotPanel
        view={view({
          dataSlotGroups: [
            {
              theme: 'Wellbeing',
              slots: [
                {
                  key: 'satisfaction',
                  name: 'Role Satisfaction',
                  description: 'How they feel',
                  paraphrase: 'They are not satisfied with their role.',
                  provenance: 'direct',
                  confidence: 0.9,
                  rationale: null,
                  filled: true,
                  provisional: false,
                  answeredAtTurnIndex: 1,
                  history: [],
                  coverage: { total: 0, answered: 0, questions: [] },
                },
              ],
            },
          ],
          progressPercent: 25,
        })}
      />
    );
    expect(screen.getByText('They are not satisfied with their role.')).toBeInTheDocument();
    // The "Inferred" marker is a bare <span>Inferred</span> — assert the actual rendered text is
    // absent (the old /^Inferred ·/ regex never matched any node, so it asserted nothing).
    expect(screen.queryByText('Inferred')).not.toBeInTheDocument();
  });

  it('renders answered values and pending placeholders', () => {
    render(<AnswerSlotPanel view={view()} />);
    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getByText('Not answered yet')).toBeInTheDocument();
    expect(screen.getByText('About you')).toBeInTheDocument();
  });

  it('previews the rationale in the collapsed row and expands on click', () => {
    render(<AnswerSlotPanel view={view()} />);
    // The model's rationale now previews one-line in the collapsed row.
    expect(screen.getByText('Stated directly.')).toBeInTheDocument();
    const row = screen.getByText('What is your role?').closest('button');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByText('What is your role?'));
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // Full rationale remains visible when expanded.
    expect(screen.getByText('Stated directly.')).toBeInTheDocument();
  });

  it('does not expand a pending slot', () => {
    render(<AnswerSlotPanel view={view()} />);
    const pendingButton = screen.getByText('How big is your team?').closest('button');
    expect(pendingButton).toBeDisabled();
  });

  it('Revisit requires a confirm, then calls onRevisit with the slot', () => {
    const onRevisit = vi.fn();
    render(<AnswerSlotPanel view={view()} onRevisit={onRevisit} canRevisit />);

    fireEvent.click(screen.getByText('What is your role?'));
    fireEvent.click(screen.getByRole('button', { name: 'Revisit' }));
    // Not sent until the confirm.
    expect(onRevisit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revisit' }));
    expect(onRevisit).toHaveBeenCalledWith(expect.objectContaining({ slotKey: 'role' }));
  });

  it('disables Revisit when canRevisit is false', () => {
    render(<AnswerSlotPanel view={view()} onRevisit={vi.fn()} canRevisit={false} />);
    fireEvent.click(screen.getByText('What is your role?'));
    expect(screen.getByRole('button', { name: 'Revisit' })).toBeDisabled();
  });

  it('hides the Revisit affordance when onRevisit is not provided', () => {
    render(<AnswerSlotPanel view={view()} />);
    fireEvent.click(screen.getByText('What is your role?'));
    expect(screen.queryByRole('button', { name: 'Revisit' })).not.toBeInTheDocument();
  });

  // --- Slot overview minimap + after-turn stepper (data-slot mode) ---

  function dataSlot(key: string, over: Partial<DataSlotPanelSlot> = {}): DataSlotPanelSlot {
    return {
      key,
      name: key,
      description: '',
      paraphrase: 'Something captured.',
      provenance: 'direct',
      confidence: 0.9,
      rationale: null,
      filled: true,
      provisional: false,
      answeredAtTurnIndex: 1,
      history: [],
      coverage: { total: 0, answered: 0, questions: [] },
      ...over,
    };
  }

  function dataSlotView(count: number, latestTurnKeys: string[] = []): AnswerPanelView {
    const latest = new Set(latestTurnKeys);
    return view({
      dataSlotGroups: [
        {
          theme: 'Demographics',
          // Keys in `latestTurnKeys` belong to a later fill-turn (index 2); the rest to turn 1 — so
          // `recentlyFilledByLatestTurn` marks only the later ones.
          slots: Array.from({ length: count }, (_, i) =>
            dataSlot(`slot-${i}`, { answeredAtTurnIndex: latest.has(`slot-${i}`) ? 2 : 1 })
          ),
        },
      ],
      progressPercent: 40,
    });
  }

  it('does not render the minimap when the list does not overflow (jsdom has zero layout)', () => {
    // The minimap only appears when the content actually overflows the viewport. In jsdom every
    // measured height is 0 → no overflow → no minimap. (Its appearance with real geometry is covered
    // in the layout-stub describe below, and SlotMiniMap has its own component test.)
    render(<AnswerSlotPanel view={dataSlotView(12)} />);
    expect(screen.queryByTestId('slot-minimap')).not.toBeInTheDocument();
  });

  it('arms the stepper footer from newlyFilledKeys and steps through, decrementing the copy', () => {
    render(
      <AnswerSlotPanel view={dataSlotView(12)} newlyFilledKeys={['slot-0', 'slot-3', 'slot-7']} />
    );
    // Footer lands on the first newly-filled slot: two more to go.
    expect(screen.getByText(/2 more answers recorded/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/2 more answers recorded/));
    // Singular copy for the last hop.
    expect(screen.getByText('1 more slot was answered')).toBeInTheDocument();
    fireEvent.click(screen.getByText('1 more slot was answered'));
    // No footer on the final slot.
    expect(screen.queryByText(/more answers recorded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/more slot was answered/)).not.toBeInTheDocument();
  });

  it('shows no stepper footer when no slots were filled this turn', () => {
    render(<AnswerSlotPanel view={dataSlotView(12)} newlyFilledKeys={[]} />);
    expect(screen.queryByText(/more answers recorded/)).not.toBeInTheDocument();
  });

  it('pulses the most-recent-turn slot rows (and leaves earlier rows unpulsed)', () => {
    // slot-1 + slot-4 belong to the later fill-turn; the rest to an earlier one.
    render(<AnswerSlotPanel view={dataSlotView(12, ['slot-1', 'slot-4'])} />);
    expect(document.getElementById('panel-slot-slot-1')!.className).toContain('cq-fill-glow');
    expect(document.getElementById('panel-slot-slot-4')!.className).toContain('cq-fill-glow');
    expect(document.getElementById('panel-slot-slot-2')!.className).not.toContain('cq-fill-glow');
  });

  // The scroll + measurement paths no-op in jsdom (zero layout height). Stub a non-zero layout and a
  // ResizeObserver so the real scroll / minimap logic executes.
  describe('navigation paths (with layout stubs)', () => {
    let offsetHeightSpy: PropertyDescriptor | undefined;

    beforeEach(() => {
      // jsdom has no ResizeObserver; the measure effect bails without one.
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
      // jsdom reports offsetHeight 0 → scrollToSlot bails; give it a real height.
      offsetHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get: () => 500,
      });
      vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (offsetHeightSpy) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightSpy);
      } else {
        // No prior own-descriptor to restore — revert to jsdom's effective 0 so the 500 override
        // can't leak into sibling tests that rely on the panel reading as not-laid-out.
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
          configurable: true,
          get: () => 0,
        });
      }
      vi.restoreAllMocks();
    });

    it('auto-scrolls to the first newly-filled slot and highlights it, then steps to the next', () => {
      render(<AnswerSlotPanel view={dataSlotView(12)} newlyFilledKeys={['slot-2', 'slot-9']} />);
      // Smooth scroll (reduced-motion stub is false in this env) — assert the behaviour contract.
      expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'smooth' })
      );
      expect(document.getElementById('panel-slot-slot-2')!.className).toContain('ring-2');
      // Stepping advances the scroll + highlight to the next newly-filled slot.
      fireEvent.click(screen.getByText(/1 more slot was answered/));
      expect(document.getElementById('panel-slot-slot-9')!.className).toContain('ring-2');
    });

    it('renders the minimap and scrubs the list when the content overflows', () => {
      // Force overflow: scrollHeight > clientHeight, and give the container a real rect.
      const scrollHeightSpy = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scrollHeight'
      );
      const clientHeightSpy = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'clientHeight'
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => 1000,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => 300,
      });
      const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        right: 0,
        bottom: 100,
        width: 0,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      try {
        render(<AnswerSlotPanel view={dataSlotView(12)} />);
        const minimap = screen.getByTestId('slot-minimap');
        expect(minimap).toBeInTheDocument();
        // A viewport window is drawn over the track.
        expect(screen.getByTestId('slot-minimap-window')).toBeInTheDocument();
        // The list reserves right padding so its text clears the floating minimap, and hides its
        // native scrollbar so the minimap stands in as the sole scroll affordance.
        const scrollContainer = minimap.parentElement?.querySelector('.overflow-y-auto');
        expect(scrollContainer!.className).toContain('pr-8');
        expect(scrollContainer!.className).toContain('cq-no-scrollbar');
        // Clicking the track scrubs the list to the clicked fraction. With the stubs (scrollHeight
        // 1000, clientHeight 300, track rect height 100), clientY 150 → fraction clamps to 1 →
        // target = min(700, 1000 - 150) = 700.
        fireEvent.pointerDown(minimap, { clientY: 150, pointerId: 1 });
        expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
          expect.objectContaining({ top: 700 })
        );
      } finally {
        if (scrollHeightSpy)
          Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightSpy);
        else
          Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get: () => 0,
          });
        if (clientHeightSpy)
          Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightSpy);
        else
          Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get: () => 0,
          });
        rectSpy.mockRestore();
      }
    });
  });
});
