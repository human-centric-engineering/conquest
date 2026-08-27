'use client';

/**
 * AnswerReviewDrawer — the mobile face of {@link AnswerSlotPanel}.
 *
 * Below `lg` the side answer panel is hidden, so respondents (mostly on phones) lose sight of
 * what they've answered and how the agent read it. This drawer surfaces the *same*
 * {@link AnswerSlotPanel} content — same data, same rows — in a bottom-sheet, triggered from
 * the lifecycle bar.
 *
 * Built on Radix `Dialog` (already a dependency) rather than a hand-rolled portal: it gives the
 * focus trap, Escape-to-close, body scroll-lock, `aria-modal`, and focus-return for free, and it
 * portals to `document.body`. That last point matters — in "both" presentation mode the surface
 * sits inside a `transform: translateX()` carousel track, and a `position: fixed` node rendered
 * in-tree would anchor to the transformed track rather than the viewport. The portal escapes it.
 *
 * Controlled only: the trigger lives in {@link SessionLifecycleBar}, so this renders no
 * `DialogTrigger` of its own.
 *
 * NOT unconditionally a below-`lg` affordance any more. It was, while every layout put the answer
 * panel beside the conversation from `lg` up — the sheet retired exactly where the panel took over.
 * Focus and Broadsheet keep review in the sheet at EVERY width instead, so the retirement is now a
 * property of the layout rather than of this component, and it arrives as {@link panelReturnsAtLg}.
 * Hard-coding `lg:hidden` here (as this did) left those layouts with a trigger that dimmed the
 * screen and revealed nothing: the overlay has no breakpoint, only the content did.
 *
 * It therefore has two shapes, not one. Narrow: the bottom sheet it has always been. Wide (only
 * reachable in a layout that keeps it): a right-hand drawer, the same edge Classic's answer panel
 * occupies, so wherever a respondent looks for their answers they are in the same place.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useRespondentSurfaceAttrs } from '@/components/app/questionnaire/chat/respondent-surface-context';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';
import type { PanelCorrection } from '@/lib/app/questionnaire/panel/correction-targets';

export interface AnswerReviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The same panel view the desktop side panel renders. */
  view: AnswerPanelView | null;
  loading: boolean;
  /** Forwarded to {@link AnswerSlotPanel}; matches `handleRevisit`'s `(slot) => void`. */
  onRevisit: (slot: PanelSlotView) => void;
  canRevisit: boolean;
  /** Data-slot "Incorrect?" probe-deeper handler, forwarded to {@link AnswerSlotPanel}. */
  onRefine?: (slot: DataSlotPanelSlot) => void;
  newlyFilledKeys: readonly string[];
  /** Inline correction bundle (Variant B), forwarded to {@link AnswerSlotPanel}. */
  correction?: PanelCorrection;
  /**
   * Does a side answer panel take over from `lg` up in this layout?
   *
   * `true` (Classic) retires the sheet there, because the panel is on screen instead and the
   * trigger is hidden too. `false` (Focus, Broadsheet) keeps it at every width, because the sheet
   * is then the ONLY route to the captured answers.
   *
   * Defaults to `true`: that is the historical behaviour, and the safe direction for a caller that
   * forgets — a sheet that retires beside a visible panel is redundant, where one that vanishes
   * with no panel behind it strands the respondent. `SessionWorkspace` reads the answer, like the
   * trigger's own `lg:hidden`, from the layout's placement declaration rather than deciding twice.
   */
  panelReturnsAtLg?: boolean;
}

export function AnswerReviewDrawer({
  open,
  onOpenChange,
  view,
  loading,
  onRevisit,
  canRevisit,
  onRefine,
  newlyFilledKeys,
  correction,
  panelReturnsAtLg = true,
}: AnswerReviewDrawerProps) {
  // Portalled to document.body, so it sits OUTSIDE the BrandThemeProvider div that carries
  // `data-surface="respondent"` and the client's `--app-*` variables — without re-applying them at
  // this root it renders in the surrounding ConQuest consumer brand (cream canvas, Fraunces
  // headings) in the middle of a neutral white-label questionnaire. `null` when there is no
  // provider above (admin surfaces render this panel too), in which case there is nothing to wear.
  // See respondent-surface-context.tsx.
  const surface = useRespondentSurfaceAttrs();

  // Wide enough for the side drawer? Only meaningful where the sheet survives at `lg` at all.
  const isWide = useMediaQuery('(min-width: 1024px)');
  const asDrawer = !panelReturnsAtLg && isWide;

  return (
    // A drawer, not a dialog, once it is on the side: `modal={false}` drops the scroll-lock, the
    // focus trap and the inert backdrop, so the conversation beside it stays readable and usable
    // while the answers are open. That is the right trade for this particular panel — reviewing
    // what you have said is a glance back at the conversation, not a task that replaces it, and a
    // respondent who has to dismiss their answers before they can re-read the question has been
    // given a worse tool. Escape, click-outside and focus-return all still work (Radix keeps them
    // without `modal`).
    //
    // The narrow bottom sheet stays modal: it covers the surface, so anything behind it is
    // unreachable anyway, and there the focus trap and scroll-lock are what make it usable.
    <Dialog open={open} onOpenChange={onOpenChange} modal={!asDrawer}>
      <DialogPortal>
        {/* No dimming behind the side drawer — a scrim over content that is still live reads as
            "this is blocked" and would be lying. The sheet keeps its overlay.

            The testid is here because whether this scrim exists IS the modal/drawer distinction as
            a respondent experiences it, and Radix exposes nothing else to assert on: it sets no
            `aria-modal` on bespoke content. Same reasoning as `workspace-scale-root`. */}
        {!asDrawer && <DialogOverlay data-testid="review-scrim" />}
        <DialogPrimitive.Content
          {...surface}
          // Opening must not steal the caret out of the composer, and autofocusing the close button
          // was also what put a focus ring around the X the moment the panel appeared.
          onOpenAutoFocus={(event) => event.preventDefault()}
          // Bottom-anchored sheet, or a side drawer from `lg` where the sheet survives. We render
          // bespoke content (not the centred `DialogContent`) purely to swap the anchoring and the
          // slide direction; all a11y behaviour stays Radix's.
          className={cn(
            'cq-suppress-scrollbars bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed z-50 flex flex-col overflow-hidden shadow-lg duration-200',
            // The narrow form: a bottom sheet across the width, thumb-reachable. The slide is
            // `max-lg:`-scoped rather than unprefixed so it cannot combine with the wide form's
            // horizontal slide below — `slide-in-from-bottom` and `slide-in-from-right` set
            // different axes, and both applying at `lg` would send the sheet in diagonally.
            'inset-x-0 bottom-0 h-[85svh] max-h-[85svh] w-full max-w-none rounded-t-xl border-t',
            'max-lg:data-[state=open]:slide-in-from-bottom max-lg:data-[state=closed]:slide-out-to-bottom',
            panelReturnsAtLg
              ? // A panel takes over at `lg`, so the sheet retires there. Without this condition it
                // hid the sheet's CONTENT while the overlay still dimmed the page — a modal that
                // opens onto nothing, which is exactly what a layout with no panel used to get.
                'lg:hidden'
              : // No panel takes over, so the sheet IS the answers at every width — and a
                // full-bleed bottom slab is a phone shape, not a desktop one: on a wide display it
                // stretched every row across ~1600px. From `lg` it becomes a right-hand drawer,
                // which is precisely where the answers sit in Classic, so the two layouts teach the
                // same place to look. Full height, so the list has room; capped in width, so the
                // rows keep a readable measure; and the conversation stays visible beside it,
                // because reviewing answers is a glance, not a destination.
                cn(
                  'lg:inset-y-0 lg:right-0 lg:left-auto lg:h-full lg:max-h-none lg:w-[32rem] lg:max-w-[92vw]',
                  'lg:rounded-none lg:border-t-0 lg:border-l',
                  // Square against the viewport edge, not a floating card: it is attached to the
                  // side of the window, and rounding the outer corners would claim otherwise. The
                  // separation comes from a deep shadow cast leftward across the conversation
                  // instead — which is also the only thing separating them now the scrim is gone.
                  'lg:shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.25)]',
                  'lg:data-[state=open]:slide-in-from-right lg:data-[state=closed]:slide-out-to-right'
                )
          )}
        >
          {/* Radix needs a title for the dialog's accessible name; the panel renders its own
              visible ProgressHeading, so keep this screen-reader-only. */}
          <DialogPrimitive.Title className="sr-only">Your answers</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Review what you&apos;ve answered so far and how it was interpreted.
          </DialogPrimitive.Description>

          {/* A quiet, properly-sized target rather than a 1px-padded glyph: it is the only way
              out of a non-modal drawer that no longer dims anything behind it. `focus-visible`
              (not `focus`) so it rings when tabbed to and not when clicked. */}
          <DialogPrimitive.Close className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring absolute top-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none">
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>

          <AnswerSlotPanel
            view={view}
            loading={loading}
            onRevisit={onRevisit}
            canRevisit={canRevisit}
            onRefine={onRefine}
            newlyFilledKeys={newlyFilledKeys}
            correction={correction}
            // The minimap is the scroll affordance; suppress the native bar (touch needs none).
            hideNativeScrollbar
            className="min-h-0 flex-1 rounded-none border-0 bg-transparent"
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
