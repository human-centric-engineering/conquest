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
      className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3', className)}
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 35%, transparent)',
        backgroundColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 7%, transparent)',
      }}
    >
      <Flag
        className="h-4 w-4 shrink-0"
        style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
        aria-hidden="true"
      />
      <p className="text-foreground min-w-0 flex-1 text-sm">
        You can keep chatting, or finish up now and we&rsquo;ll prepare your report.
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(true)}
          disabled={busy}
        >
          Continue
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onFinish}
          disabled={busy}
          className="text-[var(--app-on-cta,#fff)]"
          style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
        >
          {busy ? 'Finishing…' : 'Finish up & get my report'}
        </Button>
      </div>
    </div>
  );
}
