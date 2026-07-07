'use client';

/**
 * SessionLifecycleBar — the quiet strip above the respondent chat (F7.3).
 *
 * Home for the session-level affordances the chat itself doesn't carry: the
 * anonymous-mode indicator, the respondent Pause/Resume control (signed-in only), a soft
 * cost-budget hint, and any lifecycle-action error. Deliberately understated — it renders
 * nothing at all when there's nothing to say (the common case: an authed active session
 * with no cost pressure still shows a single Pause control).
 *
 * Brand colours come from the CSS custom properties the page's `BrandThemeProvider` sets,
 * with platform-default fallbacks.
 */

import type { ReactNode } from 'react';
import { PauseCircle, PlayCircle, ShieldCheck, Hourglass, AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SessionProgressBar } from '@/components/app/questionnaire/session-progress-bar';
import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

export interface SessionLifecycleBarProps {
  view: SessionStatusView | null;
  /** The session is respondent-paused (resumable). */
  paused: boolean;
  /** A pause/resume action is in flight. */
  busy: boolean;
  actionError: string | null;
  canPause: boolean;
  canResume: boolean;
  onPause: () => void;
  onResume: () => void;
  /**
   * Right-aligned control rendered on the strip line (e.g. the chat ↔ form mode toggle). When
   * present the strip always renders, even before the status view loads, so the control is
   * available immediately and costs no extra vertical space.
   */
  trailing?: ReactNode;
  /**
   * The transcript-download control (F7.6), rendered in the right cluster beside the ref chip.
   * When present the strip always renders so the respondent can take their conversation away
   * at any point in the session.
   */
  download?: ReactNode;
  className?: string;
}

export function SessionLifecycleBar({
  view,
  paused,
  busy,
  actionError,
  canPause,
  canResume,
  onPause,
  onResume,
  trailing,
  download,
  className,
}: SessionLifecycleBarProps) {
  const anonymous = view?.anonymous ?? false;
  // Soft cost hint only while still going — once paused/offered it's noise.
  const showCostHint = !paused && view?.cost?.tier === 'soft';
  const showResume = paused && canResume;
  const showPause = !paused && canPause;

  // The coverage bar shows whenever we have a status view (i.e. the session is live);
  // the affordance strip below it stays conditional, so a plain active session shows
  // just the progress bar.
  const showProgress = view !== null;
  const ref = view?.ref ?? null;
  // The right cluster splits into two wrap-units: an info chip and the action controls.
  const hasInfo = ref !== null || download != null;
  const hasActions = actionError !== null || showResume || showPause || trailing != null;
  const hasStrip = anonymous || showCostHint || hasInfo || hasActions;
  if (!showProgress && !hasStrip) return null;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {showProgress && <SessionProgressBar coverage={view.completion.displayCoverage} />}
      {hasStrip && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {anonymous && (
            <span
              className="inline-flex items-center gap-1.5"
              title="Your responses are not linked to an account."
            >
              <ShieldCheck
                className="h-3.5 w-3.5"
                style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
                aria-hidden="true"
              />
              Responses are anonymous
            </span>
          )}

          {showCostHint && (
            <span role="status" className="inline-flex items-center gap-1.5">
              <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
              Approaching this session&rsquo;s limit
            </span>
          )}

          {paused && (
            <span
              role="status"
              className="text-foreground inline-flex items-center gap-1.5 font-medium"
            >
              <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Paused — your progress is saved
            </span>
          )}

          {/* Two cohesive wrap-units, not a flat row: the info chip (ref/download) and the action
              controls (status + trailing toggle/review) each stay intact and wrap as a block, so on
              narrow screens the controls drop to a tidy right-aligned line instead of fragmenting. */}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {hasInfo && (
              <span className="inline-flex items-center gap-2">
                {ref && <SessionRefChip refRaw={ref} />}
                {download}
              </span>
            )}
            {hasActions && (
              <span className="flex flex-wrap items-center justify-end gap-2">
                {actionError && (
                  <span role="alert" className="text-destructive inline-flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    {actionError}
                  </span>
                )}
                {showResume && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onResume}
                    disabled={busy}
                  >
                    <PlayCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Resume
                  </Button>
                )}
                {showPause && (
                  <Button type="button" variant="ghost" size="sm" onClick={onPause} disabled={busy}>
                    <PauseCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Pause
                  </Button>
                )}
                {trailing}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
