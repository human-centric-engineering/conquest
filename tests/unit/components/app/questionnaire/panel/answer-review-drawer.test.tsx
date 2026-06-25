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
import { render, screen, fireEvent, within } from '@testing-library/react';

import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

// Mark the panel and surface the props the drawer forwards, plus a revisit button to fire.
vi.mock('@/components/app/questionnaire/panel/answer-slot-panel', () => ({
  AnswerSlotPanel: ({
    view,
    loading,
    canRevisit,
    onRevisit,
    newlyFilledKeys,
    hideNativeScrollbar,
    className,
  }: {
    view: AnswerPanelView | null;
    loading: boolean;
    canRevisit: boolean;
    onRevisit: (slot: PanelSlotView) => void;
    newlyFilledKeys?: readonly string[];
    hideNativeScrollbar?: boolean;
    className?: string;
  }) => (
    <div
      data-testid="panel"
      data-loading={String(loading)}
      data-can-revisit={String(canRevisit)}
      data-has-view={String(view !== null)}
      data-newly-filled={(newlyFilledKeys ?? []).join(',')}
      data-hide-native-scrollbar={String(Boolean(hideNativeScrollbar))}
      data-class={className}
    >
      <button type="button" onClick={() => onRevisit(SLOT)}>
        revisit
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
  refinementHistory: [],
};

const VIEW: AnswerPanelView = {
  status: 'active',
  scope: 'full_progress',
  sections: [],
  answeredCount: 3,
  totalCount: 8,
};

function renderDrawer(over: Partial<React.ComponentProps<typeof AnswerReviewDrawer>> = {}) {
  const onOpenChange = vi.fn();
  const onRevisit = vi.fn();
  render(
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
  return { onOpenChange, onRevisit };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('forwards view / loading / canRevisit / newlyFilledKeys to the panel', () => {
    renderDrawer({ loading: true, canRevisit: false, newlyFilledKeys: ['budget'] });
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('data-has-view', 'true');
    expect(panel).toHaveAttribute('data-loading', 'true');
    expect(panel).toHaveAttribute('data-can-revisit', 'false');
    expect(panel).toHaveAttribute('data-newly-filled', 'budget');
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
