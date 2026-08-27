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
 *
 * Each breakout is read for its OWN configuration — affordances, presentation, brand, vocabulary —
 * via {@link fetchSurfaceConfig}, because a meeting's steps (and the rooms inside one step) may each
 * run a different questionnaire, and this surface never re-renders on the server to pick that up.
 * See `lib/app/questionnaire/session/respondent-surface.ts` for why the read is keyed on the session
 * rather than carried in the join, poll, or room-choice payloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { fetchSurfaceConfig } from '@/lib/app/questionnaire/session/boot-fetchers';
import type { RespondentSurfaceConfig } from '@/lib/app/questionnaire/session/respondent-surface';
import { MeetingInsightPanel } from '@/components/app/questionnaire/experiences/meeting-insight-panel';
import { BreakoutRoomPicker } from '@/components/app/questionnaire/experiences/breakout-room-picker';
import {
  breakoutPhase,
  graceSecondsRemaining,
  secondsRemaining,
  canChooseRoom,
  type BreakoutRoomView,
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
  const [rooms, setRooms] = useState<BreakoutRoomView[]>([]);
  const [now, setNow] = useState<Date | null>(null);
  // The breakout's own per-version config, keyed by the session it was read for. Held as a pair
  // rather than a bare object so a stale read from the PREVIOUS breakout can never be painted onto
  // the next one: the render compares `forSessionId` against the live session before using it.
  const [surface, setSurface] = useState<{
    forSessionId: string;
    config: RespondentSurfaceConfig | null;
  } | null>(null);
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

      // Rooms only exist for some breakouts, so this is a cheap extra read rather than a shape
      // every meeting pays for.
      if (liveState.currentStepId) {
        try {
          const roomState = await apiClient.get<{ rooms: BreakoutRoomView[] }>(
            API.APP.EXPERIENCES.meetingRooms(meetingId),
            authOptions
          );
          setRooms(roomState.rooms);
        } catch {
          // Non-critical — without rooms the participant simply answers directly.
        }
      } else {
        setRooms([]);
      }
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

  // Read the breakout's own configuration whenever the session changes.
  //
  // This is the one hook that covers all three moments a session id arrives on this surface — the
  // join response, the participant poll when a breakout starts, and choosing a breakout room —
  // which is exactly why the config is keyed on the SESSION and not carried in any of those three
  // payloads. Each breakout may run a different questionnaire, and a room may run a different one
  // again from its step, so this genuinely re-reads per breakout rather than once per meeting.
  //
  // Fails soft to `null`, which renders as the workspace's own prop defaults — the behaviour this
  // surface had before the read existed. A participant is never blocked from answering by it.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      const config = await fetchSurfaceConfig(sessionId, sessionToken ?? '');
      // The breakout may have moved on while this was in flight (a short round closing, the
      // facilitator starting the next one). Dropping a late read is correct: the effect for the
      // NEW session is already running and will paint the right thing.
      if (!cancelled) setSurface({ forSessionId: sessionId, config });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionToken]);

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

  // The config, but only once it has been read FOR the session on screen. A bundle resolved for the
  // previous breakout must never paint the next one — the two can be different questionnaires.
  const surfaceReady = Boolean(session && surface?.forSessionId === session.id);
  const activeSurface = surfaceReady ? (surface?.config ?? null) : null;
  // The brand deliberately OUTLIVES the breakout it was read for: it belongs to the meeting, and
  // letting the chrome fall back to neutral in the gaps between rounds would read as the
  // participant having been dropped somewhere else. The band's HEADER is not treated this way —
  // it names the live breakout's questionnaire, which stops being true the moment that ends.
  const brand = (activeSurface ?? surface?.config)?.theme ?? null;

  // A breakout with rooms, running, and this participant has not picked one yet. `canChooseRoom`
  // excludes the grace window: arriving at a room with seconds left, to a questionnaire not yet
  // started, is worse than being told you missed it.
  const needsRoom =
    !session &&
    canChooseRoom({
      breakoutRunning: Boolean(live?.currentStepId),
      phase: phase ?? 'closed',
      hasRooms: rooms.length > 0,
    });

  if (needsRoom && runId) {
    return (
      <BreakoutRoomPicker
        meetingId={meetingId}
        runId={runId}
        rooms={rooms}
        onChosen={(result) => {
          // Null in a scribe room where somebody else holds the pen — they are in, and watching.
          if (result.sessionId) {
            setSession({ id: result.sessionId, token: result.sessionToken });
          }
        }}
      />
    );
  }

  const body = (
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
        //
        // The workspace waits for the breakout's own config rather than mounting on defaults and
        // reflowing when it lands: `presentationMode` and `answerPanelScope` decide the LAYOUT, so
        // painting first would show the wrong surface and then rearrange it under someone who is
        // already reading — and in a breakout they are reading against a clock.
        //
        // What is deliberately NOT threaded, and is not an oversight: the pre-chat gates (intro
        // splash, persona picker, profile capture) and cross-device resume. Each is a screen the
        // respondent must move THROUGH before the first question streams, which is right for a
        // questionnaire someone opens alone and wrong for a six-minute facilitated round that has
        // already been introduced out loud by a human.
        <div className="min-h-0 flex-1">
          {surfaceReady ? (
            <SessionWorkspace
              key={session.id}
              sessionId={session.id}
              accessToken={session.token}
              autoStart
              voiceInputEnabled={activeSurface?.voiceInputEnabled}
              attachmentInputEnabled={activeSurface?.attachmentInputEnabled}
              presentationMode={activeSurface?.presentationMode}
              respondentLayout={activeSurface?.respondentLayout}
              answerPanelScope={activeSurface?.answerPanelScope}
              reasoningPlacement={activeSurface?.reasoningPlacement}
              reasoningDwellMs={activeSurface?.reasoningDwellMs}
              reasoningPerItemMs={activeSurface?.reasoningPerItemMs}
              inlineCorrectionEnabled={activeSurface?.inlineCorrectionEnabled}
              showProgressPercentText={activeSurface?.showProgressPercentText}
              glossary={activeSurface?.glossary}
              glossaryAppendix={activeSurface?.glossaryAppendix}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              <span className="sr-only">Opening this round</span>
            </div>
          )}
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

  // Unbranded until the first config lands — there is nothing to brand a room WITH before a
  // breakout has revealed which questionnaire it runs. After that the band wraps everything, so a
  // breakout looks like the questionnaire it actually is rather than like generic chrome.
  if (!brand) return body;

  return (
    <BrandThemeProvider
      theme={brand}
      header={activeSurface?.header ?? null}
      anonymous={activeSurface?.anonymous ?? false}
    >
      {body}
    </BrandThemeProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <div className="bg-card w-full rounded-xl border p-6 text-center">{children}</div>
    </main>
  );
}
