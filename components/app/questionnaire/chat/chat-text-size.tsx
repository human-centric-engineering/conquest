'use client';

/**
 * ChatTextSize — the respondent's text-size stepper on the session lifecycle strip.
 *
 * Two buttons in a pill: a small "A" that steps down and a large "A" that steps up. The glyphs
 * carry the meaning at any size, in any language, without a word — which is what lets the control
 * stay this small on a strip that already holds the persona chip, the mode toggle and the review
 * trigger. Styling mirrors {@link ModeToggle} (rounded-full, hairline border, muted backdrop) so a
 * wrapped row on mobile still reads as one control group.
 *
 * Deliberately NOT a slider or a menu: a slider needs a label and a drag target neither the strip
 * nor a phone has room for, and a menu hides the affordance behind a tap at the moment someone is
 * struggling to read the screen.
 *
 * Buttons disable at the ends of the ladder rather than wrapping, and the current size is announced
 * politely so a screen-reader user hears the result of a press they cannot see.
 */

import { cn } from '@/lib/utils';
import { canStep, labelForIndex } from '@/lib/app/questionnaire/chat/text-scale';

export interface ChatTextSizeProps {
  /** Current step index into `CHAT_TEXT_SCALES`. */
  index: number;
  /**
   * Step one notch. Emits a direction rather than a computed index so clamping stays in
   * `stepScaleIndex`, beside the ladder it clamps to — a caller computing `index + 1` would run off
   * the end, where `normalizeScaleIndex` treats out-of-range as "unrecognised" and falls back to
   * Default, silently shrinking the text instead of holding at the largest step.
   */
  onStep: (direction: 'up' | 'down') => void;
  className?: string;
}

export function ChatTextSize({ index, onStep, className }: ChatTextSizeProps) {
  const canGrow = canStep(index, 'up');
  const canShrink = canStep(index, 'down');

  return (
    <div
      role="group"
      aria-label="Text size"
      className={cn(
        'bg-muted/70 relative inline-flex items-center rounded-full border p-1 backdrop-blur',
        className
      )}
    >
      {/* `aria-disabled` rather than `disabled` at the ends of the ladder. A native `disabled`
          button is removed from the tab order the instant it is pressed, dropping focus to <body>,
          so a keyboard user who steps to the smallest size loses their place and has to tab in from
          the top of the strip. `aria-disabled` announces the same state while keeping focus put;
          the handler is guarded so the press is a no-op. */}
      <button
        type="button"
        onClick={() => canShrink && onStep('down')}
        aria-disabled={!canShrink}
        aria-label="Decrease text size"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-full leading-none transition-colors',
          canShrink
            ? 'text-muted-foreground hover:text-foreground hover:bg-background/70'
            : 'text-muted-foreground/40 cursor-default'
        )}
      >
        {/* The glyph pair IS the label — sized relative to each other, not to the chat. */}
        <span aria-hidden="true" className="text-[11px] font-semibold">
          A
        </span>
      </button>
      <button
        type="button"
        onClick={() => canGrow && onStep('up')}
        aria-disabled={!canGrow}
        aria-label="Increase text size"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-full leading-none transition-colors',
          canGrow
            ? 'text-muted-foreground hover:text-foreground hover:bg-background/70'
            : 'text-muted-foreground/40 cursor-default'
        )}
      >
        <span aria-hidden="true" className="text-[15px] font-semibold">
          A
        </span>
      </button>
      {/* A press produces no visible change a non-sighted user can perceive, and at the ends of the
          ladder no change at all, so state the resulting size. */}
      <span role="status" aria-live="polite" className="sr-only">
        Text size: {labelForIndex(index)}
      </span>
    </div>
  );
}
