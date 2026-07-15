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
import { SessionEntry } from '@/components/app/questionnaire/intro/session-entry';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import type { PresentationMode, ReasoningPlacement } from '@/lib/app/questionnaire/types';
import {
  ANSWER_PROVENANCES,
  CAPTURE_MODES,
  PERSONA_SWITCHERS,
  PROFILE_FIELD_TYPES,
  PROFILE_FIELD_VALIDATION_MODES,
} from '@/lib/app/questionnaire/types';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import { REASONING_STEP_KINDS, REASONING_TONES } from '@/lib/app/questionnaire/reasoning';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';

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
   * `undefined`/null when off. Resolved server-side (platform flag AND version toggle) and
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
   * Respondent intro / splash platform flag (resolved server-side). When on, a FRESH session fetches
   * its resolved intro on boot and gates the workspace behind the splash; the per-version
   * `intro.enabled` inside the payload is the second gate. Off → no fetch, straight into the surface.
   */
  introScreenEnabled?: boolean;
  /**
   * Selectable-persona platform flag (resolved server-side). When on, the session fetches its
   * resolved persona menu on boot so the "Choose your interviewer" step can ride the carousel; the
   * per-version `personaSelection.enabled` inside the payload is the second gate. Off → no fetch.
   */
  personaSelectionEnabled?: boolean;
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
          warnings: z
            .array(
              z.object({ code: z.string(), message: z.string(), detail: z.string().optional() })
            )
            .optional(),
          reasoning: z
            .array(
              z.object({
                kind: z.enum(REASONING_STEP_KINDS),
                label: z.string(),
                tone: z.enum(REASONING_TONES),
                detail: z.string().optional(),
                rationale: z.string().optional(),
                sourceQuote: z.string().optional(),
                confidence: z.number().optional(),
                provenance: z.enum(ANSWER_PROVENANCES).optional(),
              })
            )
            .optional(),
        })
      ),
      // Preview Turn Inspector (admin-only): present only when the session is a preview with the
      // inspector toggle on; absent for a real respondent. Validated with the same schema the live
      // `inspector` frame parses through. `.catch([])` keeps a malformed trace from failing the whole
      // parse — admin debug data must never wipe the respondent's replayed transcript (the same
      // fail-soft contract the warnings/reasoning replay uses server-side).
      inspectorTurns: z.array(inspectorTurnSchema).catch([]).optional(),
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
): Promise<{ turns: QuestionnaireTurn[]; inspectorTurns: TurnInspectorData[] }> {
  const empty = { turns: [], inspectorTurns: [] };
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.transcript(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return empty;
    const parsed = transcriptResponseSchema.safeParse(await res.json());
    if (!parsed.success) return empty;
    return {
      turns: parsed.data.data?.turns ?? [],
      inspectorTurns: parsed.data.data?.inspectorTurns ?? [],
    };
  } catch {
    return empty;
  }
}

/** Resolved-intro response shape — validated at the fetch boundary (no `as` on the wire). */
const introSectionSchema = z.object({ heading: z.string(), body: z.string() });
const resolvedIntroSchema = z.object({
  enabled: z.boolean(),
  questionnaireTitle: z.string(),
  background: z.string(),
  videoUrl: z.string(),
  copy: z.object({
    howItWorks: introSectionSchema,
    whatYouGet: introSectionSchema.nullable(),
    goodToKnow: z.array(z.string()),
    buttonLabel: z.string(),
  }),
});
const introResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ intro: resolvedIntroSchema.nullable() }).optional(),
});

/**
 * Fetch the session's resolved intro (token-authed). Fails soft to `null` on any error — a splash
 * read must never block the surface from opening; the worst case is no intro screen, exactly the
 * pre-feature behaviour. Only called for a fresh session when the platform flag is on.
 */
async function fetchIntro(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionIntro | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.intro(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return null;
    const parsed = introResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.intro ?? null;
  } catch {
    return null;
  }
}

/** Persona-menu response shape — validated at the fetch boundary (no `as` on the wire). */
const personaMenuSchema = z.object({
  enabled: z.boolean(),
  personas: z.array(z.object({ key: z.string(), label: z.string(), description: z.string() })),
  selectedPersonaKey: z.string().nullable(),
  defaultPersonaKey: z.string(),
  // Fail-soft: an unknown/missing switcher falls back to the pre-chat page (original behaviour).
  switcher: z.enum(PERSONA_SWITCHERS).catch('page'),
});
const personaResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ persona: personaMenuSchema.nullable() }).optional(),
});

/**
 * Fetch the session's resolved persona menu (token-authed). Fails soft to `null` on any error — the
 * picker is an enhancement, never a blocker; the worst case is no persona step and the default voice.
 * Only called when the platform flag is on.
 */
async function fetchPersonas(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionPersonas | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.persona(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return null;
    const parsed = personaResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.persona ?? null;
  } catch {
    return null;
  }
}

/** Resolved-capture response shape — validated at the fetch boundary (no `as` on the wire). */
const profileFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(PROFILE_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  validation: z.enum(PROFILE_FIELD_VALIDATION_MODES),
});
const resolvedCaptureSchema = z.object({
  captureMode: z.enum(CAPTURE_MODES),
  fields: z.array(profileFieldSchema),
  satisfied: z.boolean(),
});
const captureResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ capture: resolvedCaptureSchema.nullable() }).optional(),
});

/**
 * Fetch the session's resolved profile capture (token-authed). Fails soft to `null` on any error — a
 * capture read must never wedge the surface. The server PUT remains the enforcing boundary, so a
 * soft-fail here at worst skips the client gate; it can never smuggle an unvalidated profile through.
 * Called on both fresh and resumed sessions (the `satisfied` flag skips the gate on resume). Returns
 * `null` for anonymous versions (the PII-free path).
 */
async function fetchCapture(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionCapture | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.profile(sessionId), {
      headers: { 'X-Session-Token': accessToken },
    });
    if (!res.ok) return null;
    const parsed = captureResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.capture ?? null;
  } catch {
    return null;
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
  presentationMode = 'both',
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  inlineCorrectionEnabled = false,
  introScreenEnabled = false,
  personaSelectionEnabled = false,
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
      const { turns, inspectorTurns } = await fetchTranscript(sessionId, accessToken);
      const resumed = turns.length > 0;
      // The intro rides the workspace carousel as a tab, so it must be present on BOTH a fresh
      // session AND a resume — a returning respondent can still slide back to re-read it. Resolve it
      // whenever the platform flag is on (skipping only that round-trip when off); `autoStart` alone
      // is resume-gated below, so a resumed session simply doesn't land on the intro. This mirrors
      // the authenticated page, which passes `intro` unconditionally.
      // Capture has no platform flag (purely per-version config, like profileFields), so it's always
      // fetched — the server returns `null` fast for anonymous versions. On resume the snapshot exists,
      // so `satisfied` is true and the gate is skipped.
      const [intro, personas, capture] = await Promise.all([
        introScreenEnabled ? fetchIntro(sessionId, accessToken) : Promise.resolve(null),
        personaSelectionEnabled ? fetchPersonas(sessionId, accessToken) : Promise.resolve(null),
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
        // Pass the fetched traces straight through — the route already returns [] (or omits the
        // field) for a fresh or non-preview session, so this is empty in exactly those cases. No
        // `resumed` gate: that signal is about the transcript, and gating inspector data on it would
        // drop fetched traces if the two ever diverged (e.g. traces present, transcript empty).
        initialInspectorTurns: inspectorTurns,
        autoStart: !resumed,
      });
    })();
  }, [
    versionId,
    preview,
    inviteToken,
    welcomeCopy,
    voiceInputEnabled,
    anonymous,
    introScreenEnabled,
    personaSelectionEnabled,
  ]);

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
