'use client';

/**
 * SessionLifecycleBar — the quiet strip above the respondent chat (F7.3).
 *
 * Home for the session-level affordances the chat itself doesn't carry: the respondent
 * Pause/Resume control (signed-in only), a soft cost-budget hint, and any lifecycle-action error.
 * The anonymous-mode indicator is NOT here — it rides the brand band above the conversation
 * (`BrandThemeProvider`), under the questionnaire title, so it costs no row on this strip.
 *
 * Deliberately understated — it renders nothing at all when there's nothing to say (the common
 * case: an authed active session with no cost pressure still shows a single Pause control).
 *
 * ## Two lines, and each one means something
 *
 * Everything used to be right-aligned into a single wrapping cluster: the progress bar on top, and
 * beneath it the reference, the download, the text-size stepper, the surface switcher and the review
 * trigger all crammed into one `ml-auto` span that wrapped wherever it ran out of room. On a laptop
 * that fragmented into three ragged right-aligned lines with an empty left half — three rows of
 * chrome above a conversation, which is the opposite of what a twenty-minute reading surface wants.
 *
 * The split is by KIND, not by width:
 *
 *   - **Status** — the coverage bar, the support reference, the transcript download. Facts about
 *     this session: how far along it is, what to quote if it goes wrong, how to take it away.
 *     Nothing here changes what is on screen.
 *   - **Controls** — the surface switcher, the text-size stepper, the review trigger, pause/resume.
 *     Things the respondent operates.
 *
 * The reference and the download moved up to the status line for that reason, and it is also what
 * buys the controls their single row back. The switcher then anchors the left (via `leading`) with
 * the tools at the right, so the row has two cohesive clusters instead of one ragged one — and when
 * it genuinely does run out of width, they wrap as two blocks rather than fragmenting.
 *
 * Brand colours come from the CSS custom properties the page's `BrandThemeProvider` sets,
 * with platform-default fallbacks.
 */

import type { ReactNode } from 'react';
import { PauseCircle, PlayCircle, Hourglass, AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SessionProgressBar } from '@/components/app/questionnaire/session-progress-bar';
import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

export interface SessionLifecycleBarProps {
  view: SessionStatusView | null;
  /** Show the "N% completed" text beside the progress bar (`config.showProgressPercentText`). The
   * bar itself always renders regardless. Default `true`. */
  showProgressPercentText?: boolean;
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
   * Right-aligned tools rendered on the control line (text size, the interviewer chip, the review
   * trigger). When present the strip always renders, even before the status view loads, so the
   * controls are available immediately and cost no extra vertical space.
   */
  trailing?: ReactNode;
  /**
   * Left-cluster slot — the controls that belong to the surface rather than to the conversation.
   * Today: the surface switcher (chat ⇄ form, and the intro / interviewer pages when present), plus
   * cross-device resume when the version disables the intro splash and so has no footer to carry it.
   * Present → the strip always renders.
   *
   * The switcher lives here rather than in `trailing` because it is the row's subject: it says which
   * surface you are on, it is the widest control on the strip, and left-aligning it against the
   * progress bar above gives the row an anchor instead of a heavy right edge over an empty left half.
   */
  leading?: ReactNode;
  /**
   * The transcript-download control (F7.6), rendered on the STATUS line beside the ref chip — both
   * are facts about this session rather than things that change what is on screen, and keeping them
   * off the control line is what lets the controls hold a single row. When present the status line
   * always renders so the respondent can take their conversation away at any point in the session.
   */
  download?: ReactNode;
  className?: string;
}

export function SessionLifecycleBar({
  view,
  showProgressPercentText = true,
  paused,
  busy,
  actionError,
  canPause,
  canResume,
  onPause,
  onResume,
  trailing,
  leading,
  download,
  className,
}: SessionLifecycleBarProps) {
  // Soft cost hint only while still going — once paused/offered it's noise.
  const showCostHint = !paused && view?.cost?.tier === 'soft';
  const showResume = paused && canResume;
  const showPause = !paused && canPause;

  // The coverage bar shows whenever we have a status view (i.e. the session is live); both lines
  // below it stay conditional, so a plain active session shows just the progress bar.
  const showProgress = view !== null;
  const ref = view?.ref ?? null;
  // Line 1 — status. Facts about this session, none of which change what is on screen.
  const hasStatus = showProgress || ref !== null || download != null;
  // Line 2 — controls. Things the respondent operates, plus the notices that report on them.
  const hasTools = showResume || showPause || trailing != null;
  const hasControls = showCostHint || paused || actionError !== null || hasTools || leading != null;
  if (!hasStatus && !hasControls) return null;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {hasStatus && (
        // `text-muted-foreground` here, not only on the control line below: the ref chip's code span
        // carries weight but no colour of its own, so on an uncoloured row it rendered in full
        // foreground ink — louder than the conversation it sits above, which is not what a support
        // reference is for.
        <div className="text-muted-foreground flex items-center gap-x-4">
          {/* `min-w-0` so the bar yields to the chip beside it instead of pushing it off the line —
              the bar is the only thing here with no intrinsic width to defend. `sharesLine` is the
              other half of that bargain: yielding is what lets the bar's own "N% completed" caption
              overflow onto its neighbour once the box is narrower than the words, so below `sm` the
              caption stands down and the bar speaks for itself. */}
          {showProgress && (
            <SessionProgressBar
              coverage={view.completion.displayCoverage}
              showPercentText={showProgressPercentText}
              sharesLine
              className="min-w-0 flex-1"
            />
          )}
          {(ref !== null || download != null) && (
            // `ml-auto` rather than relying on the bar's `flex-1`, so the pair still sits at the
            // trailing edge on the surfaces that render no bar at all.
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {ref && <SessionRefChip refRaw={ref} />}
              {download}
            </span>
          )}
        </div>
      )}

      {hasControls && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {/* The surface switcher anchors the left, aligned with the progress bar's left edge. */}
          {leading}

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

          {/* Its own wrap-unit, not folded into the tools cluster below: an error is a sentence, and
              a sentence sharing a `shrink-0` cluster with three buttons pushes them off the line. */}
          {actionError && (
            <span role="alert" className="text-destructive inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {actionError}
            </span>
          )}

          {/* The tools, as ONE cohesive unit at the trailing edge. It wraps as a block — so the
              worst case is two tidy lines (switcher, then tools), never the three ragged ones that
              came of letting every control wrap independently. `flex-wrap` inside is the last-resort
              valve for a genuinely tiny screen; it is not the normal path. */}
          {hasTools && (
            <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
        </div>
      )}
    </div>
  );
}
