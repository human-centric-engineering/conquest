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

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { SessionEntry } from '@/components/app/questionnaire/intro/session-entry';
import { SessionResumeGate } from '@/components/app/questionnaire/chat/session-resume-gate';
import {
  anonCredsKey,
  clearAnonSession,
  clearTabMarker,
  hasTabMarker,
  readAnonSession,
  setTabMarker,
  writeAnonSession,
  type StoredAnonSession,
} from '@/lib/app/questionnaire/chat/anon-session-storage';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import type { PresentationMode, ReasoningPlacement } from '@/lib/app/questionnaire/types';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import {
  VERSION_ARCHIVED_CODE,
  VERSION_ARCHIVED_MESSAGE,
} from '@/lib/app/questionnaire/version-archived';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import {
  fetchCapture,
  fetchIntro,
  fetchPersonas,
  fetchTranscript,
} from '@/lib/app/questionnaire/session/boot-fetchers';

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
  /**
   * Live "watch it think" reasoning placement (demo feature) — `overlay` | `inline`, or
   * `undefined`/null when off. Resolved server-side from the version toggle and
   * forwarded to the workspace.
   */
  reasoningPlacement?: ReasoningPlacement | null;
  /** "Animated" placement: base dwell (ms) the reasoning summary stays open for up to two steps. */
  reasoningDwellMs?: number;
  /** "Animated" placement: extra dwell (ms) per reasoning step beyond two. */
  reasoningPerItemMs?: number;
  /**
   * Inline answer correction (Variant B): resolved server-side from the version config (default on).
   * Forwarded to the workspace, which shows the "fix this answer" gesture in the chat + panel.
   */
  inlineCorrectionEnabled?: boolean;
  /**
   * Session resume opt-in (per-version config, resolved server-side). When on (and this is the public
   * anonymous path — not preview/invite), the credential is kept durably in `localStorage` so the
   * session survives a browser close, and a genuine return (new tab / after close, NOT a same-tab
   * refresh) shows the "Continue where you left off / Start new" gate. Off → the pre-resume behaviour
   * (sessionStorage only; a return mints a fresh session).
   */
  resumeEnabled?: boolean;
}

/** Session-create response shape — validated at the fetch boundary (no `as` on the wire). */
const anonCreateResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      session: z.object({ id: z.string() }),
      accessToken: z.string(),
      expiresAt: z.string(),
    })
    .optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

type BootState =
  | { phase: 'creating' }
  | {
      phase: 'ready';
      sessionId: string;
      accessToken: string;
      /** Seeded transcript: a replayed conversation on resume, else the fresh welcome turn. */
      initialTurns: QuestionnaireTurn[];
      /**
       * Preview Turn Inspector (admin-only): the persisted per-turn traces, replayed on resume so the
       * drawer re-hydrates instead of waiting for the next turn. Empty for a real respondent — the
       * transcript route only returns them for a preview session with the inspector toggle on.
       */
      initialInspectorTurns: TurnInspectorData[];
      /** Open proactively only on a fresh session (no prior turns to replay). */
      autoStart: boolean;
      /** Resolved intro for the splash gate; null when off, on resume, or when the fetch fails soft. */
      intro: ResolvedSessionIntro | null;
      /** Resolved persona menu; null when off or when the fetch fails soft. */
      personas: ResolvedSessionPersonas | null;
      /** Resolved profile capture; null for anonymous versions or when the fetch fails soft. */
      capture: ResolvedSessionCapture | null;
    }
  | {
      /** A durable session was found on a genuine return — offer Continue / Start new (resume). */
      phase: 'welcome-back';
      stored: StoredAnonSession;
      refRaw: string | null;
      answeredCount: number;
    }
  /** The version has been archived — a terminal notice, not a retryable error (no "Try again"). */
  | { phase: 'archived'; message: string }
  | { phase: 'error'; message: string };

/* The transcript / intro / persona / capture reads live in
   `lib/app/questionnaire/session/boot-fetchers.ts` — shared with the experience run surface
   (`/x/<publicRef>`), which opens a session it did not create and needs the identical four reads.
   `fetchStatus` stays here: only the durable-resume gate uses it. */

/** Status-read response shape — the fields the resume gate needs, validated at the fetch boundary. */
const statusResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      status: z.string(),
      ref: z.string().nullable().optional(),
      completion: z.object({ answeredCount: z.number() }).partial().optional(),
    })
    .optional(),
});

/**
 * Fetch a session's resumability (token-authed): its status, support ref, and answered count. Used
 * only on a genuine return (durable creds present, no tab marker) to decide whether to show the
 * welcome-back gate. Fails soft to `null` on any error — the caller then treats the session as
 * unresumable and starts fresh, exactly the pre-resume behaviour.
 */
async function fetchStatus(
  sessionId: string,
  accessToken: string
): Promise<{ status: string; ref: string | null; answeredCount: number } | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.status(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return null;
    const parsed = statusResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.data) return null;
    const d = parsed.data.data;
    return {
      status: d.status,
      ref: d.ref ?? null,
      answeredCount: d.completion?.answeredCount ?? 0,
    };
  } catch {
    return null;
  }
}

export function AnonymousSessionBoot({
  versionId,
  welcomeCopy,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  anonymous = false,
  preview = false,
  inviteToken,
  presentationMode = 'both',
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  inlineCorrectionEnabled = false,
  resumeEnabled = false,
}: AnonymousSessionBootProps) {
  const [state, setState] = useState<BootState>({ phase: 'creating' });
  // A gate action (Continue / Start new) is mid-flight — keeps the welcome-back buttons disabled
  // + spinning until the session enters (or a fresh one is minted).
  const [gateBusy, setGateBusy] = useState(false);
  // Dedup the create across React 19 StrictMode's double-invoke (which would otherwise mint two
  // sessions in dev): the ref persists across the simulated unmount/remount, so only the first
  // run fetches. We deliberately do NOT cancel the in-flight create on cleanup — StrictMode's
  // synchronous fake-unmount fires that cleanup while the component is still mounted, so a
  // cancel-guard would swallow the only `setState` and leave the boot spinning forever. A real
  // unmount mid-flight just lands a harmless no-op `setState` (React 19 ignores it).
  const startedRef = useRef(false);

  // Durable resume applies only to the public anonymous path when the version opted in — admin
  // preview and frictionless-invite sessions stay ephemeral (sessionStorage), the pre-resume
  // behaviour (invite sessions already resume server-side via their invitationId).
  const usesDurableResume = resumeEnabled && !preview && !inviteToken;
  const credsKey = anonCredsKey(versionId, preview, inviteToken);

  // Enter a resolved session: replay its transcript (incl. persisted side-band notices) when it
  // already has turns — else show the branded welcome + auto-open the first question. The intro
  // rides the carousel on BOTH fresh and resumed sessions (a returner can slide back to re-read it);
  // only `autoStart` is resume-gated. Capture is always fetched (server returns null fast for
  // anonymous versions); `satisfied` skips its gate on resume.
  const enterSession = useCallback(
    async (sessionId: string, accessToken: string) => {
      const { turns, inspectorTurns } = await fetchTranscript(sessionId, accessToken);
      const resumed = turns.length > 0;
      const [intro, personas, capture] = await Promise.all([
        fetchIntro(sessionId, accessToken),
        fetchPersonas(sessionId, accessToken),
        fetchCapture(sessionId, accessToken),
      ]);
      setState({
        phase: 'ready',
        sessionId,
        accessToken,
        intro,
        personas,
        capture,
        initialTurns: resumed
          ? turns
          : buildWelcomeTurns({ welcomeCopy, voiceInputEnabled, anonymous }),
        initialInspectorTurns: inspectorTurns,
        autoStart: !resumed,
      });
    },
    [welcomeCopy, voiceInputEnabled, anonymous]
  );

  // Mint a fresh session (invite → /from-invite, else preview / public anon), persist its credential
  // to the right store, and mark this tab entered (durable path only). Returns the stored creds, or
  // null after setting the error state.
  const createFreshSession = useCallback(async (): Promise<StoredAnonSession | null> => {
    try {
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
      const parsedBody = anonCreateResponseSchema.safeParse(await res.json());
      const body = parsedBody.success ? parsedBody.data : null;
      if (!res.ok || !body || !body.success || !body.data) {
        // An archived version is a permanent state — show the "archived" notice, not a retryable error.
        if (body?.error?.code === VERSION_ARCHIVED_CODE) {
          setState({ phase: 'archived', message: body.error.message ?? VERSION_ARCHIVED_MESSAGE });
          return null;
        }
        setState({
          phase: 'error',
          message: body?.error?.message ?? 'This questionnaire is not available right now.',
        });
        return null;
      }
      const stored: StoredAnonSession = {
        sessionId: body.data.session.id,
        accessToken: body.data.accessToken,
        expiresAt: body.data.expiresAt,
      };
      writeAnonSession(credsKey, usesDurableResume, stored);
      if (usesDurableResume) setTabMarker(versionId);
      return stored;
    } catch {
      setState({
        phase: 'error',
        message:
          'We could not start the questionnaire. Please check your connection and try again.',
      });
      return null;
    }
  }, [versionId, preview, inviteToken, credsKey, usesDurableResume]);

  // Welcome-back → Continue: mark the tab entered so a later refresh resumes silently, then enter.
  const handleContinue = useCallback(
    async (stored: StoredAnonSession) => {
      setGateBusy(true);
      setTabMarker(versionId);
      await enterSession(stored.sessionId, stored.accessToken);
    },
    [versionId, enterSession]
  );

  // Welcome-back → Start new: best-effort abandon the old session (so it's not left dangling in
  // analytics), drop the durable creds + tab marker, then mint and enter a fresh session.
  const handleStartNew = useCallback(
    async (stored: StoredAnonSession) => {
      setGateBusy(true);
      try {
        await fetch(API.APP.QUESTIONNAIRE_SESSIONS.lifecycle(stored.sessionId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Token': stored.accessToken },
          body: JSON.stringify({ action: 'abandon' }),
        });
      } catch {
        // Best-effort — a failed abandon just leaves the old session to age out via retention.
      }
      clearAnonSession(credsKey);
      clearTabMarker(versionId);
      setState({ phase: 'creating' });
      const fresh = await createFreshSession();
      if (fresh) await enterSession(fresh.sessionId, fresh.accessToken);
      setGateBusy(false);
    },
    [versionId, credsKey, createFreshSession, enterSession]
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      if (usesDurableResume) {
        const existing = readAnonSession(credsKey, true);
        if (existing) {
          // A same-tab refresh (marker present) resumes silently — the returning-respondent gate is
          // only for a genuine return (new tab / after close), where the marker is absent.
          if (hasTabMarker(versionId)) {
            await enterSession(existing.sessionId, existing.accessToken);
            return;
          }
          // Genuine return: confirm the session is still resumable (active/paused with real
          // progress) before offering to continue it. Otherwise fall through to a fresh start.
          const status = await fetchStatus(existing.sessionId, existing.accessToken);
          const resumable =
            status !== null &&
            (status.status === 'active' || status.status === 'paused') &&
            status.answeredCount >= 1;
          if (resumable) {
            setState({
              phase: 'welcome-back',
              stored: existing,
              refRaw: status.ref,
              answeredCount: status.answeredCount,
            });
            return;
          }
          // Terminal / invalid token / no progress — drop the stale credential and start fresh.
          clearAnonSession(credsKey);
        }
        const fresh = await createFreshSession();
        if (fresh) await enterSession(fresh.sessionId, fresh.accessToken);
        return;
      }

      // Non-durable path (admin preview / frictionless invite / resume off): reuse a still-valid
      // stored token (refresh within the 24h TTL), else mint fresh — the pre-resume behaviour.
      const existing = readAnonSession(credsKey, false);
      if (existing) {
        await enterSession(existing.sessionId, existing.accessToken);
        return;
      }
      const fresh = await createFreshSession();
      if (fresh) await enterSession(fresh.sessionId, fresh.accessToken);
    })();
  }, [versionId, credsKey, usesDurableResume, enterSession, createFreshSession]);

  if (state.phase === 'creating') {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden="true" />
        <span className="sr-only">Starting your questionnaire…</span>
      </div>
    );
  }

  if (state.phase === 'welcome-back') {
    return (
      <SessionResumeGate
        versionId={versionId}
        refRaw={state.refRaw}
        answeredCount={state.answeredCount}
        onContinue={() => void handleContinue(state.stored)}
        onStartNew={() => void handleStartNew(state.stored)}
        busy={gateBusy}
      />
    );
  }

  if (state.phase === 'archived') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-foreground text-base font-semibold">
          This questionnaire has been archived
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">{state.message}</p>
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
    <SessionEntry
      intro={state.intro}
      personas={state.personas}
      capture={state.capture}
      sessionId={state.sessionId}
      accessToken={state.accessToken}
      // A fresh session seeds the welcome turn and auto-opens the first question; a resumed one
      // seeds its replayed transcript (so the prior conversation + its notices are restored) and
      // does NOT auto-open — the last asked question is already on screen from the replay.
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
