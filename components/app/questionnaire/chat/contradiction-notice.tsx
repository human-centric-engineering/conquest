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
import { NoticeWhy } from '@/components/app/questionnaire/chat/notice-why';

export interface ContradictionNoticeProps {
  /** The agent's probe / explanation of the possible inconsistency. */
  message: string;
  /** The contradiction's explanation when the message shown is the probe — behind a "Why?" disclosure. */
  detail?: string;
  className?: string;
}

export function ContradictionNotice({ message, detail, className }: ContradictionNoticeProps) {
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
        {/* whitespace-pre-line so a combined multi-conflict notice renders its line breaks. */}
        <p className="text-muted-foreground mt-0.5 whitespace-pre-line">{message}</p>
        <NoticeWhy detail={detail} />
      </div>
    </div>
  );
}
