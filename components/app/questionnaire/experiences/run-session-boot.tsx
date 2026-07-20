'use client';

/**
 * Client bootstrap for the experience run surface, `/x/<publicRef>` (P15.3).
 *
 * The sibling of `AnonymousSessionBoot`, and deliberately much smaller: that component's job is to
 * CREATE a session and manage a durable credential across returns. This one opens a session that
 * already exists, with a credential the server resolved from the run cookie and handed down for
 * this render only. There is no create path, no storage, and no resume gate — the run cookie is
 * the durable thing, and it lives out of reach of JavaScript.
 *
 * It exists at all because the four boot reads (transcript, intro, personas, capture) are
 * token-authed and therefore cannot run during the server render without putting the token into
 * server-rendered HTML.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { SessionEntry } from '@/components/app/questionnaire/intro/session-entry';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import {
  fetchCapture,
  fetchIntro,
  fetchPersonas,
  fetchTranscript,
} from '@/lib/app/questionnaire/session/boot-fetchers';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import type { PresentationMode, ReasoningPlacement } from '@/lib/app/questionnaire/types';

export interface RunSessionBootProps {
  sessionId: string;
  /** Minted server-side for this render; absent for an authenticated respondent (cookie suffices). */
  accessToken?: string;
  welcomeCopy?: string;
  voiceInputEnabled?: boolean;
  attachmentInputEnabled?: boolean;
  anonymous?: boolean;
  presentationMode?: PresentationMode;
  reasoningPlacement?: ReasoningPlacement | null;
  reasoningDwellMs?: number;
  reasoningPerItemMs?: number;
  inlineCorrectionEnabled?: boolean;
}

type BootState =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      initialTurns: QuestionnaireTurn[];
      initialInspectorTurns: TurnInspectorData[];
      autoStart: boolean;
      intro: ResolvedSessionIntro | null;
      personas: ResolvedSessionPersonas | null;
      capture: ResolvedSessionCapture | null;
    };

export function RunSessionBoot({
  sessionId,
  accessToken,
  welcomeCopy,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  anonymous = false,
  presentationMode,
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  inlineCorrectionEnabled = false,
}: RunSessionBootProps) {
  const [state, setState] = useState<BootState>({ phase: 'loading' });
  // Dedup across React 19 StrictMode's double-invoke. Harmless here (these are reads, not a
  // create) but it halves the boot requests in development.
  const startedRef = useRef(false);

  const enter = useCallback(async () => {
    // An authenticated respondent has no token; the reads then run on their cookie. The fetchers
    // send an empty header rather than branching, and every one of them fails soft.
    const token = accessToken ?? '';
    const { turns, inspectorTurns } = await fetchTranscript(sessionId, token);
    const resumed = turns.length > 0;
    const [intro, personas, capture] = await Promise.all([
      fetchIntro(sessionId, token),
      fetchPersonas(sessionId, token),
      fetchCapture(sessionId, token),
    ]);
    setState({
      phase: 'ready',
      intro,
      personas,
      capture,
      // A leg minted by a handoff opens with the bridging line already persisted as its first
      // turn, so `resumed` is true from the start and the generic welcome is correctly skipped.
      initialTurns: resumed
        ? turns
        : buildWelcomeTurns({ welcomeCopy, voiceInputEnabled, anonymous }),
      initialInspectorTurns: inspectorTurns,
      autoStart: !resumed,
    });
  }, [sessionId, accessToken, welcomeCopy, voiceInputEnabled, anonymous]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void enter();
  }, [enter]);

  if (state.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        <span className="sr-only">Opening your conversation</span>
      </div>
    );
  }

  return (
    <SessionEntry
      sessionId={sessionId}
      accessToken={accessToken}
      intro={state.intro}
      personas={state.personas}
      capture={state.capture}
      initialTurns={state.initialTurns}
      initialInspectorTurns={state.initialInspectorTurns}
      autoStart={state.autoStart}
      presentationMode={presentationMode}
      voiceInputEnabled={voiceInputEnabled}
      attachmentInputEnabled={attachmentInputEnabled}
      reasoningPlacement={reasoningPlacement}
      reasoningDwellMs={reasoningDwellMs}
      reasoningPerItemMs={reasoningPerItemMs}
      inlineCorrectionEnabled={inlineCorrectionEnabled}
    />
  );
}
