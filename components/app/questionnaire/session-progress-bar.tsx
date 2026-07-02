'use client';

/**
 * SessionProgressBar — a slim weighted-coverage bar for the respondent surface (F7.3).
 *
 * Drives off the F4.5 completion assessment's graded `displayCoverage` (0–1) — full credit for
 * confirmed answers, half for below-floor tentative captures — already projected onto
 * {@link SessionStatusView} and fetched by `useSessionLifecycle`. Graded (not the strict gate
 * `coverage`) so a session mid-capture reads real momentum instead of a flat 0%; the submit gate
 * stays strict and reads `completion.kind`, never this. A quiet "we're getting somewhere" signal —
 * rendered both in the lifecycle strip and (because the answer panel is hidden below `lg`) in the
 * chat header so narrow viewports keep it.
 *
 * Quiet-signal discipline, like the answer panel's confidence dot: it shows progress, not
 * the underlying weights or thresholds. Brand colour comes from the page's
 * `BrandThemeProvider` CSS vars.
 *
 * `// DEMO-ONLY (F7.3):` questionnaire-domain affordance.
 */

import { cn } from '@/lib/utils';

export interface SessionProgressBarProps {
  /** Weighted coverage in [0, 1]; out-of-range values are clamped. */
  coverage: number;
  className?: string;
}

export function SessionProgressBar({ coverage, className }: SessionProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, coverage)) * 100);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Questionnaire progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${pct}%`,
            backgroundColor: 'var(--app-accent-color, var(--color-primary))',
          }}
        />
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{pct}% completed</span>
    </div>
  );
}
