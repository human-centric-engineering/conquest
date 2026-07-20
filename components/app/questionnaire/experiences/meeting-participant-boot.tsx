'use client';

/**
 * The participant's surface in a facilitated meeting (P15.5).
 *
 * A meeting is not a questionnaire you work through at your own pace — it is a room moving
 * together. So this surface spends most of its life WAITING, and the waiting states are the
 * feature, not filler:
 *
 *  - before the meeting starts, and between breakouts, there is deliberately nothing to do. The
 *    facilitator is talking. Showing a composer here would invite someone to type while being
 *    spoken to, and their answer would land in whichever breakout started next.
 *  - during a breakout, the questionnaire appears with the room's clock above it.
 *  - during GRACE, the composer stays live for anyone mid-sentence but the copy changes to
 *    "finish up" — they may submit what they have, not begin something new.
 *
 * The analysis appears here only if the author turned it on AND chose to put it on people's own
 * screens; the default is the shared screen alone, because a room looking at one thing together is
 * a different meeting from forty people looking down at phones.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { MeetingInsightPanel } from '@/components/app/questionnaire/experiences/meeting-insight-panel';
import {
  breakoutPhase,
  graceSecondsRemaining,
  secondsRemaining,
  type MeetingInsightView,
  type MeetingLiveState,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import type { ParticipantWindow } from '@/lib/app/questionnaire/experiences/meeting/lifecycle';
import type { ExperienceInsightDisplay } from '@/lib/app/questionnaire/experiences/types';

const POLL_MS = 3_000;

export interface MeetingParticipantBootProps {
  meetingId: string;
  title: string;
  /** Resolved server-side: already `none` when the experience has not opted in. */
  insightDisplay: ExperienceInsightDisplay;
}

interface JoinResponse {
  runId: string;
  meetingId: string;
  sessionId: string | null;
  sessionToken?: string;
}

interface ParticipantResponse {
  sessionId: string | null;
  window: ParticipantWindow;
  sessionToken?: string;
}

type LiveResponse = MeetingLiveState & { insights: MeetingInsightView[] };

type BootState =
  | { phase: 'joining' }
  | { phase: 'not_started' }
  | { phase: 'error'; message: string }
  | { phase: 'joined'; runId: string };

export function MeetingParticipantBoot({
  meetingId,
  title,
  insightDisplay,
}: MeetingParticipantBootProps) {
  const [boot, setBoot] = useState<BootState>({ phase: 'joining' });
  const [session, setSession] = useState<{ id: string; token?: string } | null>(null);
  const [participantWindow, setParticipantWindow] = useState<ParticipantWindow | null>(null);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  // Dedup the join across React 19 StrictMode's double-invoke, which would otherwise put two
  // participants in the room and make the facilitator's count wrong.
  const joined = useRef(false);

  useEffect(() => {
    if (joined.current) return;
    joined.current = true;

    void (async () => {
      try {
        const result = await apiClient.post<JoinResponse>(
          API.APP.EXPERIENCES.meetingJoin(meetingId),
          { body: {} }
        );
        if (result.sessionId) {
          setSession({ id: result.sessionId, token: result.sessionToken });
        }
        setBoot({ phase: 'joined', runId: result.runId });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        // "Not started" is not an error — they are in the right place, just early.
        setBoot(
          /not started/i.test(message)
            ? { phase: 'not_started' }
            : { phase: 'error', message: message || 'We could not get you in. Please try again.' }
        );
      }
    })();
  }, [meetingId]);

  const runId = boot.phase === 'joined' ? boot.runId : null;
  // Destructured rather than read as `session?.token` inside the callback: the React compiler
  // cannot preserve manual memoization across an optional-chained member expression in a
  // dependency list, and silently dropping the memo would re-create the poll every render.
  const sessionId = session?.id ?? null;
  const sessionToken = session?.token;

  const poll = useCallback(async () => {
    if (!runId) return;
    // Built inside the callback, not above it: a fresh object in the dependency list would change
    // identity every render and defeat the memo entirely.
    const authOptions = sessionToken
      ? { options: { headers: { 'X-Session-Token': sessionToken } } }
      : undefined;
    try {
      const [state, liveState] = await Promise.all([
        apiClient.get<ParticipantResponse>(
          API.APP.EXPERIENCES.meetingParticipant(meetingId, runId),
          authOptions
        ),
        apiClient.get<LiveResponse>(API.APP.EXPERIENCES.meetingLive(meetingId), authOptions),
      ]);
      setParticipantWindow(state.window);
      setLive(liveState);
      if (state.sessionId && state.sessionId !== sessionId) {
        // A breakout started since the last poll — this is the participant's session for it.
        setSession({ id: state.sessionId, token: state.sessionToken });
      }
    } catch {
      // A dropped poll is not a failed meeting; keep what is on screen.
    }
  }, [meetingId, runId, sessionId, sessionToken]);

  useEffect(() => {
    if (!runId) return;
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), 1_000);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [runId, poll]);

  if (boot.phase === 'joining') {
    return (
      <Centered>
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        <span className="sr-only">Joining</span>
      </Centered>
    );
  }

  if (boot.phase === 'not_started') {
    return (
      <Centered>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground mt-2 text-sm">
          You&apos;re in the right place — this hasn&apos;t started yet. Keep this open and it will
          begin automatically.
        </p>
      </Centered>
    );
  }

  if (boot.phase === 'error') {
    return (
      <Centered>
        <p className="font-medium">We couldn&apos;t get you in</p>
        <p className="text-muted-foreground mt-2 text-sm">{boot.message}</p>
      </Centered>
    );
  }

  const clockNow = now ?? new Date();
  const phase = live
    ? breakoutPhase(live.breakoutEndsAt, live.breakoutGraceSeconds, clockNow)
    : null;
  const remaining = live ? secondsRemaining(live.breakoutEndsAt, clockNow) : null;
  const grace = live
    ? graceSecondsRemaining(live.breakoutEndsAt, live.breakoutGraceSeconds, clockNow)
    : null;

  const answering = Boolean(session && participantWindow?.canSubmit);

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-4xl flex-col gap-3 px-4 py-4">
      {/* The room's clock, above whatever they are doing. During grace the instruction changes —
          "30 seconds to finish and send" is a different thing from "30 seconds left". */}
      {answering && live?.currentStepTitle && (
        <div className="bg-card flex items-center justify-between rounded-xl border px-4 py-2">
          <span className="truncate text-sm font-medium">{live.currentStepTitle}</span>
          {phase === 'grace' ? (
            <span className="text-sm font-medium text-amber-600 dark:text-amber-500">
              Finish up — {grace}s to send
            </span>
          ) : remaining !== null ? (
            <span className="text-muted-foreground text-sm tabular-nums">
              {Math.floor(remaining / 60)}:{(remaining % 60).toString().padStart(2, '0')}
            </span>
          ) : null}
        </div>
      )}

      {answering && session ? (
        // `key` per session so a new breakout mounts a fresh workspace rather than reusing the
        // previous breakout's stream and transcript.
        <div className="min-h-0 flex-1">
          <SessionWorkspace
            key={session.id}
            sessionId={session.id}
            accessToken={session.token}
            autoStart
          />
        </div>
      ) : (
        <Centered>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground mt-2 text-sm">
            {live?.status === 'ended'
              ? 'That’s the end of this session — thanks for taking part.'
              : 'Nothing to do right now. Listen out for the facilitator — this will open when the next part begins.'}
          </p>
        </Centered>
      )}

      {/* The analysis on the participant's own screen, when the author chose to put it there. */}
      {insightDisplay !== 'none' && live && live.insights.length > 0 && (
        <MeetingInsightPanel insights={live.insights} display={insightDisplay} />
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <div className="bg-card w-full rounded-xl border p-6 text-center">{children}</div>
    </main>
  );
}
