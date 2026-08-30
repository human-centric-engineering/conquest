'use client';

/**
 * EarlyFinishControl — the respondent-controlled "Continue or finish up" affordance.
 *
 * Shown once the early-finish escape hatch unlocks (`canFinishEarly`) and the agent's own full
 * submit offer is NOT yet available — so it never competes with {@link CompletionOffer}, which
 * takes over the moment the session is genuinely "done enough". Unlike that one-time banner this
 * control is *persistent*: the respondent has crossed the admin's minimum bar and may end whenever
 * they like.
 *
 * To stay calm rather than nag, "Continue" collapses the full prompt to a slim, always-present
 * "Finish up now" link — the choice never disappears, it just gets out of the way.
 *
 * Layout: the actions **always** get their own row beneath the message, never a column beside it.
 * The respondent surface is set in a monospace brand font and carries a reader-controlled text-size
 * dial, so "does the sentence and both buttons fit on one line?" has no stable answer — the earlier
 * `flex-wrap` row answered it with a `flex-1` paragraph that shrank to a one-word-per-line column
 * while the `whitespace-nowrap` buttons kept their full width. Statement, then choices, at every
 * width removes the question instead of re-tuning it.
 *
 * The one thing that does vary is the pair itself, and it is keyed on a **container query** rather
 * than a viewport breakpoint: this banner sits inside the chat column, whose width is set by the
 * respondent layout (Classic / Focus / Broadsheet / Horizon) and by the admin preview frame, so the
 * viewport is not what decides whether two buttons fit side by side. Below 28rem of banner width
 * they stack full-width — proper thumb targets on a phone; above it they sit together, trailing.
 *
 * Brand colours come from the page's `BrandThemeProvider` CSS vars.
 */

import { useState } from 'react';
import { Flag } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface EarlyFinishControlProps {
  /** End the session early and prepare the report. */
  onFinish: () => void;
  /** A submit/finish is in flight. */
  busy: boolean;
  className?: string;
}

export function EarlyFinishControl({ onFinish, busy, className }: EarlyFinishControlProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className={cn('flex justify-end', className)}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onFinish}
          disabled={busy}
          className="text-muted-foreground"
        >
          <Flag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {busy ? 'Finishing…' : 'Finish up now'}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Continue or finish up"
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
          <Flag
            className="mt-0.5 h-4 w-4 shrink-0"
            style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
            aria-hidden="true"
          />
          <p className="text-foreground min-w-0 text-sm leading-relaxed text-pretty">
            You can keep chatting, or finish up now and we&rsquo;ll prepare your report.
          </p>
        </div>
        <div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(true)}
            disabled={busy}
            className="w-full @md:w-auto"
          >
            Continue
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onFinish}
            disabled={busy}
            className="w-full text-[var(--app-on-cta,#fff)] @md:w-auto"
            style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
          >
            {busy ? 'Finishing…' : 'Finish up & get my report'}
          </Button>
        </div>
      </div>
    </div>
  );
}
