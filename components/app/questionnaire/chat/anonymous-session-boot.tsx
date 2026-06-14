'use client';

/**
 * AnonymousSessionBoot — client bootstrap for the no-login respondent surface (F7.1).
 *
 * The session must be created from the client so the signed `accessToken` lives in client
 * memory (and `sessionStorage` for refresh survival inside its 24h TTL) and is never
 * serialized into server-rendered HTML. On mount it reuses a stored token for this version if
 * one is still valid, otherwise POSTs to the create route, then hands the session + token to
 * {@link SessionWorkspace} (chat + the live answer panel). The panel can't SSR-seed here (the
 * token is client-only), so it shows a brief skeleton until its first fetch lands.
 *
 * Two modes, same token machinery:
 *  - default — the public no-login surface (`/anonymous`, requires anonymous mode).
 *  - `preview` — an admin "Preview as respondent" walkthrough (`/preview`, admin-gated,
 *    `isPreview`); works on any launched version, anonymous or invitation-gated. Stored under
 *    a separate key so a preview run never clashes with a real anonymous session.
 *
 * @see app/api/v1/app/questionnaire-sessions/anonymous/route.ts
 * @see app/api/v1/app/questionnaire-sessions/preview/route.ts
 */

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { SessionWorkspace } from '@/components/app/questionnaire/session-workspace';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import type { PresentationMode } from '@/lib/app/questionnaire/types';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

interface AnonymousSessionBootProps {
  versionId: string;
  /** Branded intro line (F7.1-PR4); falls back to the platform default. */
  welcomeCopy?: string;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
  /** Show the attachment affordance (gated server-side on the attachment-input flag). */
  attachmentInputEnabled?: boolean;
  /**
   * Version is configured `anonymousMode` — drives the opening turn's "your name and details
   * won't be passed on" reassurance. Resolved server-side from the version config.
   */
  anonymous?: boolean;
  /**
   * Admin preview mode: create via the admin-gated `/preview` route (works on any launched
   * version, anonymous or not) instead of the public `/anonymous` route. Set by `?preview=1`.
   */
  preview?: boolean;
  /**
   * Frictionless invite token (`?i=`): when set, boot a no-login session bound to THIS invitation
   * via `/from-invite` instead of the public `/anonymous` route. Stored under a token-namespaced key
   * so a shared device never crosses two invitees' sessions.
   */
  inviteToken?: string;
  /**
   * How the respondent completes the session (P-presentation). Forwarded to the workspace; the
   * form view itself fetches client-side here (no SSR seed — the token is client-only).
   */
  presentationMode?: PresentationMode;
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
  | {
      phase: 'ready';
      sessionId: string;
      accessToken: string;
      /** Seeded transcript: a replayed conversation on resume, else the fresh welcome turn. */
      initialTurns: QuestionnaireTurn[];
      /** Open proactively only on a fresh session (no prior turns to replay). */
      autoStart: boolean;
    }
  | { phase: 'error'; message: string };

/** The transcript-read response shape — validated at the fetch boundary (no `as` on the wire). */
const transcriptResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      turns: z.array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
        })
      ),
    })
    .optional(),
});

/**
 * Fetch the session's replayed transcript (token-authed). Fails soft to an empty transcript on any
 * error — a transcript read must never block the surface from opening; the worst case is a fresh
 * greeting + a re-asked opening question, exactly the pre-replay behaviour.
 */
async function fetchTranscript(
  sessionId: string,
  accessToken: string
): Promise<QuestionnaireTurn[]> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.transcript(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return [];
    const parsed = transcriptResponseSchema.safeParse(await res.json());
    return parsed.success ? (parsed.data.data?.turns ?? []) : [];
  } catch {
    return [];
  }
}

function storageKey(versionId: string, preview: boolean, inviteToken?: string): string {
  // Invite sessions key on the token (truncated) — a shared device must not cross two invitees.
  if (inviteToken) return `qn.invite.${inviteToken.slice(0, 16)}`;
  return `${preview ? 'qn.preview' : 'qn.anon'}.${versionId}`;
}

function readStored(
  versionId: string,
  preview: boolean,
  inviteToken?: string
): StoredAnonSession | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(versionId, preview, inviteToken));
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
  attachmentInputEnabled = false,
  anonymous = false,
  preview = false,
  inviteToken,
  presentationMode = 'chat',
}: AnonymousSessionBootProps) {
  const [state, setState] = useState<BootState>({ phase: 'creating' });
  // Dedup the create across React 19 StrictMode's double-invoke (which would otherwise mint two
  // sessions in dev): the ref persists across the simulated unmount/remount, so only the first
  // run fetches. We deliberately do NOT cancel the in-flight create on cleanup — StrictMode's
  // synchronous fake-unmount fires that cleanup while the component is still mounted, so a
  // cancel-guard would swallow the only `setState` and leave the boot spinning forever. A real
  // unmount mid-flight just lands a harmless no-op `setState` (React 19 ignores it).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      // Resolve a session + token: reuse a still-valid stored one (refresh within the 24h TTL),
      // else mint a fresh session.
      let sessionId: string;
      let accessToken: string;

      const existing = readStored(versionId, preview, inviteToken);
      if (existing) {
        sessionId = existing.sessionId;
        accessToken = existing.accessToken;
      } else {
        try {
          // Frictionless invite link → /from-invite ({ inviteToken }); else preview / public anon.
          const endpoint = inviteToken
            ? API.APP.QUESTIONNAIRE_SESSIONS.FROM_INVITE
            : preview
              ? API.APP.QUESTIONNAIRE_SESSIONS.PREVIEW
              : API.APP.QUESTIONNAIRE_SESSIONS.ANONYMOUS;
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(inviteToken ? { inviteToken } : { versionId }),
          });
          const body = (await res.json()) as AnonCreateResponse;

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
            window.sessionStorage.setItem(
              storageKey(versionId, preview, inviteToken),
              JSON.stringify(stored)
            );
          } catch {
            // Storage unavailable (private mode) — the in-memory token still works for this load.
          }
          sessionId = stored.sessionId;
          accessToken = stored.accessToken;
        } catch {
          setState({
            phase: 'error',
            message:
              'We could not start the questionnaire. Please check your connection and try again.',
          });
          return;
        }
      }

      // Replay a prior conversation (incl. its persisted side-band notices) when this session
      // already has turns — e.g. a refresh of a session in progress. A fresh session has none, so
      // it shows the branded welcome and auto-opens the first question. (The token is client-only,
      // so unlike the authenticated page this can't SSR-seed — hence the on-boot fetch.)
      const turns = await fetchTranscript(sessionId, accessToken);
      const resumed = turns.length > 0;
      setState({
        phase: 'ready',
        sessionId,
        accessToken,
        initialTurns: resumed
          ? turns
          : buildWelcomeTurns({ welcomeCopy, voiceInputEnabled, anonymous }),
        autoStart: !resumed,
      });
    })();
  }, [versionId, preview, inviteToken, welcomeCopy, voiceInputEnabled, anonymous]);

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
    <SessionWorkspace
      sessionId={state.sessionId}
      accessToken={state.accessToken}
      // A fresh session seeds the welcome turn and auto-opens the first question; a resumed one
      // seeds its replayed transcript (so the prior conversation + its notices are restored) and
      // does NOT auto-open — the last asked question is already on screen from the replay.
      initialTurns={state.initialTurns}
      autoStart={state.autoStart}
      presentationMode={presentationMode}
      voiceInputEnabled={voiceInputEnabled}
      attachmentInputEnabled={attachmentInputEnabled}
    />
  );
}
