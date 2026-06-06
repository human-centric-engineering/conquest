'use client';

/**
 * AnonymousSessionBoot — client bootstrap for the no-login respondent surface (F7.1).
 *
 * The anonymous session must be created from the client so the signed `accessToken` lives in
 * client memory (and `sessionStorage` for refresh survival inside its 24h TTL) and is never
 * serialized into server-rendered HTML. On mount it reuses a stored token for this version if
 * one is still valid, otherwise POSTs to the anonymous create route, then hands the session +
 * token to {@link QuestionnaireChat}.
 *
 * @see app/api/v1/app/questionnaire-sessions/anonymous/route.ts
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';

interface AnonymousSessionBootProps {
  versionId: string;
  /** Branded intro line (F7.1-PR4); falls back to the platform default. */
  welcomeCopy?: string;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
}

interface StoredAnonSession {
  sessionId: string;
  accessToken: string;
  expiresAt: string;
}

interface AnonCreateResponse {
  success: boolean;
  data?: { session: { id: string }; accessToken: string; expiresAt: string };
  error?: { code?: string; message?: string };
}

type BootState =
  | { phase: 'creating' }
  | { phase: 'ready'; sessionId: string; accessToken: string }
  | { phase: 'error'; message: string };

function storageKey(versionId: string): string {
  return `qn.anon.${versionId}`;
}

function readStored(versionId: string): StoredAnonSession | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(versionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAnonSession>;
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      new Date(parsed.expiresAt).getTime() > Date.now()
    ) {
      return parsed as StoredAnonSession;
    }
  } catch {
    // Corrupt / unavailable storage — fall through to a fresh create.
  }
  return null;
}

export function AnonymousSessionBoot({
  versionId,
  welcomeCopy,
  voiceInputEnabled = false,
}: AnonymousSessionBootProps) {
  const [state, setState] = useState<BootState>({ phase: 'creating' });
  // Guard against React 19 StrictMode's double-invoke minting two sessions in dev.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const existing = readStored(versionId);
    if (existing) {
      setState({
        phase: 'ready',
        sessionId: existing.sessionId,
        accessToken: existing.accessToken,
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.ANONYMOUS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId }),
        });
        const body = (await res.json()) as AnonCreateResponse;
        if (cancelled) return;

        if (!res.ok || !body.success || !body.data) {
          setState({
            phase: 'error',
            message: body.error?.message ?? 'This questionnaire is not available right now.',
          });
          return;
        }

        const stored: StoredAnonSession = {
          sessionId: body.data.session.id,
          accessToken: body.data.accessToken,
          expiresAt: body.data.expiresAt,
        };
        try {
          window.sessionStorage.setItem(storageKey(versionId), JSON.stringify(stored));
        } catch {
          // Storage unavailable (private mode) — the in-memory token still works for this load.
        }
        setState({ phase: 'ready', sessionId: stored.sessionId, accessToken: stored.accessToken });
      } catch {
        if (!cancelled) {
          setState({
            phase: 'error',
            message:
              'We could not start the questionnaire. Please check your connection and try again.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (state.phase === 'creating') {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden="true" />
        <span className="sr-only">Starting your questionnaire…</span>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-foreground text-base font-semibold">
          We couldn’t start the questionnaire
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">{state.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <QuestionnaireChat
      sessionId={state.sessionId}
      accessToken={state.accessToken}
      initialTurns={buildWelcomeTurns({ welcomeCopy })}
      voiceInputEnabled={voiceInputEnabled}
      className="h-full"
    />
  );
}
