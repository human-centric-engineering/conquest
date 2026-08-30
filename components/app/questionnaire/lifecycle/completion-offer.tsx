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
  className?: string;
}

export function CompletionOffer({ onSubmit, busy, className }: CompletionOfferProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

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
