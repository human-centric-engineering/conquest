/**
 * AnswerReviewDrawer — the mobile bottom-sheet face of the answer panel.
 *
 * The drawer's own job is narrow: when open, render {@link AnswerSlotPanel} with the props it
 * was handed inside a Radix modal dialog, and route every dismissal (Escape, overlay, close
 * button) back through `onOpenChange`. The panel itself is mocked so these tests pin the
 * wiring, not the panel's rendering (which has its own suite).
 *
 * @see components/app/questionnaire/panel/answer-review-drawer.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The side-drawer form is chosen by viewport, and happy-dom reports no width worth trusting — so
// the breakpoint is driven directly. `false` (the default) is the narrow bottom sheet.
const isWide = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => isWide.value,
}));
import { render, screen, fireEvent, within } from '@testing-library/react';

import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

/** A branded client, so the `--app-*` variables the drawer has to carry actually exist. */
const THEME: ResolvedTheme = {
  ctaColor: '#112233',
  accentColor: '#445566',
  logoUrl: null,
  bannerUrl: null,
  welcomeCopy: 'hello',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
  hasBrandIdentity: true,
};

// Mark the panel and surface the props the drawer forwards, plus a revisit button to fire.
vi.mock('@/components/app/questionnaire/panel/answer-slot-panel', () => ({
  AnswerSlotPanel: ({
    view,
    loading,
    canRevisit,
    onRevisit,
    onRefine,
    correction,
    newlyFilledKeys,
    hideNativeScrollbar,
    headerInsetEnd,
    className,
  }: {
    view: AnswerPanelView | null;
    loading: boolean;
    canRevisit: boolean;
    onRevisit: (slot: PanelSlotView) => void;
    onRefine?: (slot: PanelSlotView) => void;
    correction?: unknown;
    newlyFilledKeys?: readonly string[];
    hideNativeScrollbar?: boolean;
    headerInsetEnd?: boolean;
    className?: string;
  }) => (
    <div
      data-testid="panel"
      data-loading={String(loading)}
      data-can-revisit={String(canRevisit)}
      data-has-view={String(view !== null)}
      data-newly-filled={(newlyFilledKeys ?? []).join(',')}
      data-hide-native-scrollbar={String(Boolean(hideNativeScrollbar))}
      data-header-inset-end={String(Boolean(headerInsetEnd))}
      data-class={className}
      // Both are forwarded by the real drawer. Surfaced rather than swallowed so that dropping
      // either prop fails a test: refine sends a fresh probe turn, and `correction` is what makes
      // the inline "fix this answer" editor reachable from a panel row.
      data-has-refine={String(typeof onRefine === 'function')}
      data-has-correction={String(correction !== undefined)}
    >
      <button type="button" onClick={() => onRevisit(SLOT)}>
        revisit
      </button>
      <button type="button" onClick={() => onRefine?.(SLOT)}>
        refine
      </button>
    </div>
  ),
}));

import { AnswerReviewDrawer } from '@/components/app/questionnaire/panel/answer-review-drawer';

const SLOT: PanelSlotView = {
  slotKey: 'budget',
  prompt: 'What is your budget?',
  type: 'free_text',
  typeConfig: null,
  required: true,
  answered: true,
  value: '£10k',
  provenance: 'direct',
  confidence: 0.8,
  rationale: null,
  answeredAtTurnIndex: 2,
  respondentEdited: false,
  refinementHistory: [],
};

const VIEW: AnswerPanelView = {
  status: 'active',
  scope: 'full_progress',
  sections: [],
  answeredCount: 3,
  totalCount: 8,
};

function drawer(
  over: Partial<React.ComponentProps<typeof AnswerReviewDrawer>>,
  onOpenChange: () => void,
  onRevisit: (slot: PanelSlotView) => void
) {
  return (
    <AnswerReviewDrawer
      open
      onOpenChange={onOpenChange}
      view={VIEW}
      loading={false}
      canRevisit
      newlyFilledKeys={[]}
      onRevisit={onRevisit}
      {...over}
    />
  );
}

/** The real case: inside the respondent surface, whose brand the portal has to carry out with it. */
function renderDrawer(over: Partial<React.ComponentProps<typeof AnswerReviewDrawer>> = {}) {
  const onOpenChange = vi.fn();
  const onRevisit = vi.fn();
  // Supplied by default (overridable) so every render exercises the same prop set the respondent
  // surface actually passes — the container always hands the drawer both actions.
  const onRefine = vi.fn();
  render(
    <BrandThemeProvider theme={THEME}>
      {drawer({ onRefine, ...over }, onOpenChange, onRevisit)}
    </BrandThemeProvider>
  );
  return { onOpenChange, onRevisit, onRefine };
}

/** No provider above — the admin surfaces render this panel too, and have no brand to inherit. */
function renderBare(over: Partial<React.ComponentProps<typeof AnswerReviewDrawer>> = {}) {
  const onOpenChange = vi.fn();
  const onRevisit = vi.fn();
  render(drawer(over, onOpenChange, onRevisit));
  return { onOpenChange, onRevisit };
}

beforeEach(() => {
  vi.clearAllMocks();
  isWide.value = false;
});

describe('AnswerReviewDrawer', () => {
  it('renders no dialog content while closed', () => {
    renderDrawer({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('renders the panel inside a modal dialog named "Your answers" when open', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    // The accessible name comes from the sr-only DialogTitle.
    expect(dialog).toHaveAccessibleName('Your answers');
    expect(within(dialog).getByTestId('panel')).toBeInTheDocument();
  });

  it('suppresses native scrollbars across the whole sheet (minimap/touch is the affordance)', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    // The sheet clips its own overflow and scopes scrollbar suppression to every descendant, so no
    // native bar can hug the edge regardless of which element scrolls.
    expect(dialog).toHaveClass('cq-suppress-scrollbars');
    expect(dialog).toHaveClass('overflow-hidden');
  });

  describe('when the sheet retires at lg', () => {
    // A shipped bug, and the reason this has its own block. While every layout put a panel beside
    // the conversation from `lg` up, this component hard-coded `lg:hidden` — correct, because the
    // trigger was hidden there too. Focus and Broadsheet keep review in the sheet at EVERY width
    // and drop the trigger's `lg:hidden`, and the hard-coded one here then hid only the CONTENT:
    // the overlay has no breakpoint, so clicking "Review answers" on a desktop dimmed the page and
    // showed nothing. Whether the sheet retires is a property of the layout, so it is a prop.

    it('retires at lg when a panel takes over there (Classic)', () => {
      renderDrawer({ panelReturnsAtLg: true });
      expect(screen.getByRole('dialog')).toHaveClass('lg:hidden');
    });

    it('stays at every width when nothing takes over (Focus, Broadsheet)', () => {
      // The assertion that would have caught it: with no panel behind it, the sheet IS the answers.
      renderDrawer({ panelReturnsAtLg: false });
      expect(screen.getByRole('dialog')).not.toHaveClass('lg:hidden');
    });

    it('retires by default, which is the safe direction for a caller that forgets', () => {
      // Redundant beside a visible panel; the other way round strands the respondent.
      renderDrawer();
      expect(screen.getByRole('dialog')).toHaveClass('lg:hidden');
    });
  });

  describe('drawer, not modal, once it is on the side', () => {
    it('drops modality at lg where the sheet stays, so the conversation stays usable', () => {
      // The point of the change: reviewing what you have said is a glance back at the conversation,
      // not a task that replaces it. A respondent who must dismiss their answers before they can
      // re-read the question has been handed a worse tool. The scrim's absence is the honest
      // signal — nothing is dimmed, because nothing behind it has been switched off.
      isWide.value = true;
      renderDrawer({ panelReturnsAtLg: false });
      expect(screen.queryByTestId('review-scrim')).toBeNull();
    });

    it('stays modal as a narrow bottom sheet, where it covers everything anyway', () => {
      isWide.value = false;
      renderDrawer({ panelReturnsAtLg: false });
      expect(screen.getByTestId('review-scrim')).toBeInTheDocument();
    });

    it('stays modal at lg in a layout whose sheet retires there', () => {
      // Classic: the sheet is a phone affordance only, so widening the window never turns it into
      // a drawer — it simply is not on screen.
      isWide.value = true;
      renderDrawer({ panelReturnsAtLg: true });
      expect(screen.getByTestId('review-scrim')).toBeInTheDocument();
    });

    it('does not steal focus from the composer when it opens', () => {
      // Autofocusing the close button both moved the caret out of the answer box and drew a focus
      // ring around the X the instant the panel appeared.
      renderDrawer();
      expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    });
  });

  describe('wearing the respondent surface through the portal', () => {
    // Radix portals this to document.body, which is OUTSIDE the BrandThemeProvider div carrying
    // `data-surface="respondent"` and the client's `--app-*` variables. Without re-applying them
    // here the panel renders in the surrounding ConQuest consumer brand — cream canvas, Fraunces
    // headings — in the middle of a neutral white-label questionnaire. It always did; nobody saw it
    // while this was a phone-width sheet, and it became obvious the moment a layout kept it on a
    // desktop.

    it('marks the portalled root as the respondent surface', () => {
      renderDrawer();
      expect(screen.getByRole('dialog')).toHaveAttribute('data-surface', 'respondent');
    });

    it('carries the client brand variables onto the portalled root', () => {
      renderDrawer();
      // Asserted as "the accent survived the portal" rather than by matching a whole style string,
      // which would break on any unrelated token being added to the theme.
      expect(screen.getByRole('dialog').getAttribute('style')).toContain('--app-accent-color');
    });

    it('renders without a provider above it (admin surfaces have no brand at all)', () => {
      renderBare();
      const dialog = screen.getByRole('dialog');
      expect(dialog).not.toHaveAttribute('data-surface');
      expect(within(dialog).getByTestId('panel')).toBeInTheDocument();
    });
  });

  it('forwards view / loading / canRevisit / newlyFilledKeys to the panel', () => {
    renderDrawer({ loading: true, canRevisit: false, newlyFilledKeys: ['budget'] });
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('data-has-view', 'true');
    expect(panel).toHaveAttribute('data-loading', 'true');
    expect(panel).toHaveAttribute('data-can-revisit', 'false');
    expect(panel).toHaveAttribute('data-newly-filled', 'budget');
  });

  it('forwards the refine action through to the panel', () => {
    // Refine sends a fresh probe turn. The drawer's job is only to pass the handler down —
    // DISMISSING the sheet afterwards belongs to the container (`session-workspace.tsx` wraps both
    // `onRevisit` and `onRefine` with `setReviewOpen(false)`), which is why nothing here asserts a
    // close. The prop had no test at all, so dropping it on the way to the panel was free.
    const { onRefine, onOpenChange } = renderDrawer();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-has-refine', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'refine' }));

    expect(onRefine).toHaveBeenCalledWith(SLOT);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('tells the panel to inset its header, so the help icon clears the close button', () => {
    // Both live in the same 32px of top-right corner: the drawer's X is `absolute top-3 right-3`,
    // and the panel header's "How this works" icon is the last thing in its own title row. Stacked,
    // the one you want to hit sits behind the one you don't.
    renderDrawer();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-header-inset-end', 'true');
  });

  it('carries the real motion class rather than the inert animation utilities', () => {
    // `animate-in` / `slide-in-from-right` / `fade-in-0` come from `tailwindcss-animate`, which
    // this project does not install — they were dead class names, which is why the drawer appeared
    // instead of sliding. The motion is real CSS in globals.css keyed on Radix's `[data-state]`,
    // and jsdom computes no animation, so the class IS the assertion.
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('cq-answer-drawer');
    expect(dialog.className).not.toContain('animate-in');
    expect(dialog.className).not.toContain('slide-in-from');
  });

  it('opts the side form into the horizontal slide', () => {
    // Two directions on one element would send it in diagonally — the reason the old bottom slide
    // was `max-lg:`-scoped. Now the sheet takes the CSS default (up from the floor) and only the
    // side form adds the modifier.
    isWide.value = true;
    renderDrawer({ panelReturnsAtLg: false });
    expect(screen.getByRole('dialog').className).toContain('cq-answer-drawer-side');
  });

  it('leaves the bottom sheet on the default (upward) slide', () => {
    // Classic: the sheet retires at `lg` rather than becoming a drawer, so it never wants the
    // horizontal direction.
    renderDrawer({ panelReturnsAtLg: true });
    expect(screen.getByRole('dialog').className).not.toContain('cq-answer-drawer-side');
  });

  it('strips the panel card chrome so it sits flush in the sheet', () => {
    renderDrawer();
    expect(screen.getByTestId('panel')).toHaveAttribute(
      'data-class',
      expect.stringContaining('border-0')
    );
  });

  it('tells the panel to suppress its native scrollbar (the minimap is the scroll affordance)', () => {
    renderDrawer();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-hide-native-scrollbar', 'true');
  });

  it('passes a null view straight through (panel renders its own empty state)', () => {
    renderDrawer({ view: null });
    expect(screen.getByTestId('panel')).toHaveAttribute('data-has-view', 'false');
  });

  it('routes the close button through onOpenChange', () => {
    const { onOpenChange } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('routes Escape through onOpenChange', () => {
    const { onOpenChange } = renderDrawer();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('bubbles a child revisit up to onRevisit', () => {
    const { onRevisit } = renderDrawer();
    fireEvent.click(screen.getByText('revisit'));
    expect(onRevisit).toHaveBeenCalledWith(SLOT);
  });
});
