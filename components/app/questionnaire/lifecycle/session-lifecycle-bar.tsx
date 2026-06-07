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

import { PauseCircle, PlayCircle, ShieldCheck, Hourglass, AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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
  className,
}: SessionLifecycleBarProps) {
  const anonymous = view?.anonymous ?? false;
  // Soft cost hint only while still going — once paused/offered it's noise.
  const showCostHint = !paused && view?.cost?.tier === 'soft';
  const showResume = paused && canResume;
  const showPause = !paused && canPause;

  const hasContent = anonymous || showCostHint || showResume || showPause || actionError !== null;
  if (!hasContent) return null;

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs',
        className
      )}
    >
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

      <span className="ml-auto inline-flex items-center gap-2">
        {actionError && (
          <span role="alert" className="text-destructive inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {actionError}
          </span>
        )}
        {showResume && (
          <Button type="button" variant="outline" size="sm" onClick={onResume} disabled={busy}>
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
      </span>
    </div>
  );
}
