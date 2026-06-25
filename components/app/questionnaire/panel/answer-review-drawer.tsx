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
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

export interface AnswerReviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The same panel view the desktop side panel renders. */
  view: AnswerPanelView | null;
  loading: boolean;
  /** Forwarded to {@link AnswerSlotPanel}; matches `handleRevisit`'s `(slot) => void`. */
  onRevisit: (slot: PanelSlotView) => void;
  canRevisit: boolean;
  newlyFilledKeys: readonly string[];
}

export function AnswerReviewDrawer({
  open,
  onOpenChange,
  view,
  loading,
  onRevisit,
  canRevisit,
  newlyFilledKeys,
}: AnswerReviewDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          // Bottom-anchored sheet. We render bespoke content (not the centred `DialogContent`)
          // purely to swap the centring + slide direction; all a11y behaviour stays Radix's.
          className="cq-suppress-scrollbars bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom fixed inset-x-0 bottom-0 z-50 flex h-[85svh] max-h-[85svh] w-full max-w-none flex-col overflow-hidden rounded-t-xl border-t shadow-lg duration-200 lg:hidden"
        >
          {/* Radix needs a title for the dialog's accessible name; the panel renders its own
              visible ProgressHeading, so keep this screen-reader-only. */}
          <DialogPrimitive.Title className="sr-only">Your answers</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Review what you&apos;ve answered so far and how it was interpreted.
          </DialogPrimitive.Description>

          <DialogPrimitive.Close className="ring-offset-background focus:ring-ring hover:bg-accent absolute top-3 right-3 z-10 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>

          <AnswerSlotPanel
            view={view}
            loading={loading}
            onRevisit={onRevisit}
            canRevisit={canRevisit}
            newlyFilledKeys={newlyFilledKeys}
            // The minimap is the scroll affordance; suppress the native bar (touch needs none).
            hideNativeScrollbar
            className="min-h-0 flex-1 rounded-none border-0 bg-transparent"
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
