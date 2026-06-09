'use client';

/**
 * ContradictionNotice — the "the agent noticed something" callout in the respondent
 * chat (F7.2 surfacing).
 *
 * When the per-turn orchestrator's contradiction detection (F4.3) flags a possible
 * inconsistency, it streams a `warning` event with `code: 'contradiction'` whose message
 * is the agent's `suggestedProbe`/`explanation`. The chat renders most warnings as a quiet
 * fail-soft line; this one is the single best "the AI is reasoning about your answers"
 * signal, so it gets a tasteful accent-bordered callout instead. Presentational only —
 * the message text is decided upstream.
 *
 * Brand colour comes from the page's `BrandThemeProvider` CSS vars, matching the
 * `AssistantTurn` accent dot.
 *
 * `// DEMO-ONLY (F7.2):` questionnaire-domain notice.
 */

import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ContradictionNoticeProps {
  /** The agent's probe / explanation of the possible inconsistency. */
  message: string;
  className?: string;
}

export function ContradictionNotice({ message, className }: ContradictionNoticeProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-relaxed',
        className
      )}
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 40%, transparent)',
        backgroundColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 6%, transparent)',
      }}
    >
      <Sparkles
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-foreground text-xs font-medium">I noticed something</p>
        <p className="text-muted-foreground mt-0.5">{message}</p>
      </div>
    </div>
  );
}
