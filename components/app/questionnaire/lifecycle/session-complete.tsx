'use client';

/**
 * SessionComplete — the post-submission confirmation (F7.3).
 *
 * Replaces the workspace once the respondent submits. A calm, positive close to the
 * conversation (distinct in tone from {@link ChatErrorPanel}'s blocking states), themed
 * via the page's `BrandThemeProvider` CSS vars. Shows a count of captured answers when
 * known, so the respondent sees their effort acknowledged.
 */

import { CheckCircle2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface SessionCompleteProps {
  /** Number of answers captured, or null when unknown. */
  answeredCount: number | null;
  className?: string;
}

export function SessionComplete({ answeredCount, className }: SessionCompleteProps) {
  return (
    <div className={cn('flex h-full min-h-0 items-center justify-center p-6', className)}>
      <div
        role="status"
        aria-live="polite"
        className="bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border px-8 py-10 text-center"
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 14%, transparent)',
            color: 'var(--app-accent-color, var(--color-primary))',
          }}
        >
          <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-foreground text-xl font-semibold text-balance">
            Thank you — your responses are submitted
          </h1>
          <p className="text-muted-foreground text-sm text-balance">
            {answeredCount !== null && answeredCount > 0
              ? `We captured ${answeredCount} answer${answeredCount === 1 ? '' : 's'} from our conversation. There's nothing more you need to do.`
              : "There's nothing more you need to do."}
          </p>
        </div>
      </div>
    </div>
  );
}
