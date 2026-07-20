'use client';

/**
 * The facilitator console (P15.5) — running a meeting from the front of a room.
 *
 * ## Designed for an unknown surface
 *
 * This may be on a laptop only the facilitator sees, a projector the room reads, or a Zoom share
 * where it is the ONLY thing anyone can see. Nothing about the viewport tells us which, so the
 * experience's `consoleDisplayMode` does: `presentation` scales type up and strips the controls
 * back for distance and video compression.
 *
 * ## The clock advises; it never acts
 *
 * The countdown ticks locally every second — no request — and turns into an explicit OVER TIME
 * state rather than going negative or auto-closing anything. A room running three minutes over is
 * normal facilitation. Only the facilitator ends a breakout.
 *
 * ## What the facilitator actually watches
 *
 * "Are they done yet" is the single most-watched number here, so completed-of-joined is the
 * largest thing on the screen after the clock. Everything else is secondary to knowing whether it
 * is time to pull the room back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, Sparkles, Check, Eye, EyeOff } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  breakoutPhase,
  graceSecondsRemaining,
  secondsRemaining,
  EXPERIENCE_INSIGHT_KIND_LABELS,
  type MeetingInsightView,
  type MeetingLiveState,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import type { ExperienceConsoleDisplay } from '@/lib/app/questionnaire/experiences/types';

/** How often the console re-reads the room. */
const POLL_MS = 3_000;

export interface ConsoleStep {
  id: string;
  title: string;
  kind: string;
  durationSeconds: number | null;
  briefing: string | null;
}

export interface MeetingConsoleProps {
  meetingId: string;
  joinUrl: string;
  steps: ConsoleStep[];
  displayMode: ExperienceConsoleDisplay;
}

type LiveResponse = MeetingLiveState & {
  audience: string;
  insights: MeetingInsightView[];
  withheld: number;
};

/** mm:ss, or a dash when there is no clock. */
function clockText(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MeetingConsole({ meetingId, joinUrl, steps, displayMode }: MeetingConsoleProps) {
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ticks once a second purely to re-render the clock. Kept separate from the poll so the
  // countdown is smooth without asking the server every second.
  const [now, setNow] = useState<Date | null>(null);
  const stopped = useRef(false);

  const big = displayMode === 'presentation';
  const breakouts = steps.filter((s) => s.kind === 'breakout');

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.get<LiveResponse>(API.APP.EXPERIENCES.meetingLive(meetingId));
      setLive(next);
    } catch {
      // A dropped poll is not a failed meeting — keep the last known state on screen. A facilitator
      // mid-sentence must not have the room's numbers replaced by an error.
    }
  }, [meetingId]);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    // Stamped in the effect, never at render: reading the clock during render differs between the
    // server render and its hydration.
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), 1_000);
    return () => {
      stopped.current = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await apiClient.post(API.APP.EXPERIENCES.meetingActions(meetingId), { body });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [meetingId, refresh]
  );

  const toggleInsight = useCallback(
    async (insight: MeetingInsightView, patch: Partial<MeetingInsightView>) => {
      try {
        await apiClient.patch(API.APP.EXPERIENCES.meetingInsight(meetingId, insight.id), {
          body: patch,
        });
        await refresh();
      } catch {
        // Non-critical: the next poll re-reads the truth.
      }
    },
    [meetingId, refresh]
  );

  if (!live) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        <span className="sr-only">Loading the meeting</span>
      </div>
    );
  }

  const clockNow = now ?? new Date();
  const phase = breakoutPhase(live.breakoutEndsAt, live.breakoutGraceSeconds, clockNow);
  const remaining = secondsRemaining(live.breakoutEndsAt, clockNow);
  const grace = graceSecondsRemaining(live.breakoutEndsAt, live.breakoutGraceSeconds, clockNow);
  const running = live.currentStepId !== null;

  return (
    <div className={cn('space-y-6', big && 'text-lg')}>
      {/* Join code — the thing that goes on the slide. Largest element before the meeting starts,
          because that is the only moment it matters. */}
      {live.status === 'scheduled' && (
        <div className="bg-card rounded-xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">Ask the room to go to</p>
          <p className={cn('mt-2 font-mono font-medium break-all', big ? 'text-4xl' : 'text-2xl')}>
            {joinUrl}
          </p>
          <Button className="mt-4" disabled={busy} onClick={() => void act({ action: 'start' })}>
            <Play className="mr-2 h-4 w-4" />
            Start the meeting
          </Button>
        </div>
      )}

      {live.status === 'live' && (
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div className="bg-card rounded-xl border p-6">
            <p className="text-muted-foreground text-sm">
              {running ? live.currentStepTitle : 'Between breakouts'}
            </p>

            {/* The two numbers a facilitator actually watches. */}
            <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <div>
                <span className={cn('font-semibold tabular-nums', big ? 'text-6xl' : 'text-4xl')}>
                  {live.completedCount}
                </span>
                <span className="text-muted-foreground ml-2">
                  of {live.participantCount} finished
                </span>
              </div>
              {running && (
                <div>
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      big ? 'text-6xl' : 'text-4xl',
                      phase === 'grace' && 'text-amber-600 dark:text-amber-500',
                      phase === 'closed' && 'text-muted-foreground'
                    )}
                  >
                    {phase === 'grace' ? clockText(grace) : clockText(remaining)}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    {phase === 'grace'
                      ? 'to submit'
                      : phase === 'closed'
                        ? 'closed'
                        : remaining === 0
                          ? 'over time'
                          : 'left'}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {!running &&
              breakouts.map((step) => (
                <Button
                  key={step.id}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act({ action: 'start_breakout', stepId: step.id })}
                >
                  <Play className="mr-2 h-4 w-4" />
                  {step.title}
                  {step.durationSeconds ? (
                    <span className="text-muted-foreground ml-2 text-xs">
                      {Math.round(step.durationSeconds / 60)}m
                    </span>
                  ) : null}
                </Button>
              ))}

            {running && phase !== 'closed' && (
              <Button disabled={busy} onClick={() => void act({ action: 'end_breakout' })}>
                <Square className="mr-2 h-4 w-4" />
                {phase === 'grace' ? 'Wrapping up…' : 'Pull them back'}
              </Button>
            )}
            {running && phase === 'closed' && (
              <Button disabled={busy} onClick={() => void act({ action: 'close_breakout' })}>
                Move on
              </Button>
            )}
            {running && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act({ action: 'synthesise' })}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Synthesise now
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'end' })}>
              End meeting
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* The walkthrough. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className={cn('font-medium', big ? 'text-2xl' : 'text-lg')}>What the room said</h2>
          {live.withheld > 0 && (
            // A count only, never the statements themselves — being able to read the withheld
            // findings would be reading exactly the attributable ones the gate exists to prevent.
            // But the facilitator must know their synthesis was thinned, or they read the gaps as
            // "everyone agreed".
            <span className="text-muted-foreground text-sm">
              {live.withheld} finding{live.withheld === 1 ? '' : 's'} held back — too few people to
              share without identifying them
            </span>
          )}
        </div>

        {live.insights.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border p-6 text-sm">
            Nothing yet. A synthesis appears once enough of the room has finished a breakout.
          </p>
        ) : (
          <ol className="space-y-2">
            {live.insights.map((insight) => (
              <li
                key={insight.id}
                className={cn('bg-card rounded-xl border p-4', insight.covered && 'opacity-60')}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs tracking-wide uppercase">
                      {EXPERIENCE_INSIGHT_KIND_LABELS[insight.kind]} · {insight.supportCount} people
                    </p>
                    <p className={cn('mt-1 font-medium', big && 'text-2xl')}>{insight.statement}</p>
                    {insight.detail && (
                      <p className="text-muted-foreground mt-1 text-sm">{insight.detail}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant={insight.covered ? 'secondary' : 'ghost'}
                      aria-label={insight.covered ? 'Mark as not covered' : 'Mark as covered'}
                      onClick={() => void toggleInsight(insight, { covered: !insight.covered })}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={
                        insight.visibleToRespondents ? 'Hide from the room' : 'Show to the room'
                      }
                      onClick={() =>
                        void toggleInsight(insight, {
                          visibleToRespondents: !insight.visibleToRespondents,
                        })
                      }
                    >
                      {insight.visibleToRespondents ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <EyeOff className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
