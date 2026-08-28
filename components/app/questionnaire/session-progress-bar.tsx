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
  /** Show the "N% completed" text beside the bar. The bar itself always renders. Default `true`. */
  showPercentText?: boolean;
  /**
   * This bar is SHARING its line with something else, so shed the percent text below `sm` rather
   * than let it collide with the neighbour.
   *
   * Set on the lifecycle strip's status line, where the bar sits beside the support-reference chip
   * and the transcript download. The bar is `flex-1` and the chip is not, so under about 450px the
   * bar's box shrinks past its own text — and the text is `shrink-0`, so it does not wrap or
   * truncate, it OVERFLOWS: "0% completedRef: HY26-91TE", printed one on top of the other.
   *
   * Shedding the text rather than the bar, because the bar is the signal and the text is a reading
   * of it; a percentage bar at 40% still says 40% with no caption. Nothing is lost to assistive
   * tech either — `aria-valuenow` lives on the bar, not on the text.
   *
   * Off by default: a bar that owns its line (the chat header, the standalone `progress` slot) has
   * the room and should keep the number at every width.
   */
  sharesLine?: boolean;
  className?: string;
}

export function SessionProgressBar({
  coverage,
  showPercentText = true,
  sharesLine = false,
  className,
}: SessionProgressBarProps) {
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
      {showPercentText && (
        <span
          className={cn(
            'text-muted-foreground shrink-0 text-xs tabular-nums',
            // See `sharesLine`: below `sm` this text would overflow its shrunken box and print on
            // top of whatever shares the line, so it stands down instead.
            sharesLine && 'hidden sm:inline'
          )}
        >
          {pct}% completed
        </span>
      )}
    </div>
  );
}
