'use client';

/**
 * CompletionOffer — the Submit affordance above the chat (F7.3).
 *
 * Appears the moment `GET …/status` reports the session is ready to submit (the agent has
 * also said so in the transcript). A single calm CTA: submitting transitions the session
 * to `completed` and swaps the surface to {@link SessionComplete}. "Keep going" simply
 * dismisses the banner — the respondent can carry on; it reappears on the next settle if
 * still offerable.
 *
 * Layout is a **container query**, not a viewport breakpoint — see {@link EarlyFinishControl},
 * whose banner this one shares a slot (and a shape) with: the chat column's width, not the
 * viewport's, decides whether message and actions fit on one row.
 *
 * Two shapes, chosen by the host layout's placement rather than by width (the container reads the
 * declaration and passes it down, exactly as it does for the composer's `prominent`):
 *
 *  - `banner` — the tinted card. What a layout that gives this its own row above the conversation
 *    wants, and still the default.
 *  - `bar` — one condensed row for a layout that puts it in the conversation card's chrome band
 *    (Classic). Same words and the same two actions; it simply stops being a card inside a card.
 *    The actions still wrap onto their own line when the band is narrow, because the surface is set
 *    in a brand font with a reader-controlled text-size dial and "does this fit on one line?" has no
 *    stable answer here.
 *
 * Brand colours come from the page's `BrandThemeProvider` CSS vars.
 */

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface CompletionOfferProps {
  onSubmit: () => void;
  /** A submit is in flight. */
  busy: boolean;
  /** `bar` condenses it for a layout that places it in the conversation card's chrome band. */
  variant?: 'banner' | 'bar';
  className?: string;
}

export function CompletionOffer({
  onSubmit,
  busy,
  variant = 'banner',
  className,
}: CompletionOfferProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  if (variant === 'bar') {
    return (
      <div
        role="region"
        aria-label="Submit your responses"
        className={cn(
          '@container flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5',
          className
        )}
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)',
        }}
      >
        <Sparkles
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
          aria-hidden="true"
        />
        <p className="text-foreground min-w-0 flex-1 text-xs leading-snug text-pretty">
          You&rsquo;ve covered enough to submit. Ready to finish?
        </p>
        {/* The pair moves as one: wrapping them separately would leave "Keep going" stranded on the
            line above its consequence. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDismissed(true)}
            disabled={busy}
            className="h-7 px-2 text-xs"
          >
            Keep going
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={busy}
            className="h-7 px-2.5 text-xs text-[var(--app-on-cta,#fff)]"
            style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
          >
            {busy ? 'Submitting…' : 'Submit responses'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Submit your responses"
      className={cn('@container rounded-xl border px-4 py-3', className)}
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 35%, transparent)',
        backgroundColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 7%, transparent)',
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles
            className="mt-0.5 h-4 w-4 shrink-0"
            style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
            aria-hidden="true"
          />
          <p className="text-foreground min-w-0 text-sm leading-relaxed text-pretty">
            You&rsquo;ve covered enough to submit. Ready to finish?
          </p>
        </div>
        <div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDismissed(true)}
            disabled={busy}
            className="w-full @md:w-auto"
          >
            Keep going
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={busy}
            className="w-full text-[var(--app-on-cta,#fff)] @md:w-auto"
            style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
          >
            {busy ? 'Submitting…' : 'Submit responses'}
          </Button>
        </div>
      </div>
    </div>
  );
}
