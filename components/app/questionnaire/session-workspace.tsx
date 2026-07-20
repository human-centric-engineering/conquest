'use client';

/**
 * SessionWorkspace — the respondent split-screen: chat + live answer panel + lifecycle
 * affordances (F7.2 + F7.3).
 *
 * Owns the single {@link useQuestionnaireSessionStream} instance, the {@link useAnswerPanel}
 * fetch, and the {@link useSessionLifecycle} fetch, then renders {@link QuestionnaireChat} and
 * {@link AnswerSlotPanel} side by side beneath a {@link SessionLifecycleBar}. One shared
 * stream is what lets the panel's "Revisit" and the lifecycle actions send turns / push
 * status through the same loop the chat uses; both the panel and the status view refetch
 * whenever a turn settles (`onTurnSettled`).
 *
 * When the respondent submits, the surface swaps to {@link SessionComplete} — a calm
 * themed confirmation, not the chat. The completion *offer* (a Submit affordance) appears
 * above the chat the moment `GET …/status` reports the session is ready.
 *
 * Layout: a single readable chat column with a fixed-width panel beside it on `lg`+;
 * below `lg` the panel is hidden and the chat is full-width (the F7.1 experience). Both
 * sit under the page's `BrandThemeProvider`, so they inherit the brand CSS vars with no
 * prop-drilling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ClipboardList, Drama, ListChecks, MessageSquare } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useHorizontalSwipe } from '@/lib/hooks/use-horizontal-swipe';
import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { useFormAnswers } from '@/lib/hooks/use-form-answers';
import { useSessionLifecycle } from '@/lib/hooks/use-session-lifecycle';
import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import { AnswerReviewDrawer } from '@/components/app/questionnaire/panel/answer-review-drawer';
import { Button } from '@/components/ui/button';
import { QuestionnaireForm } from '@/components/app/questionnaire/form/questionnaire-form';
import {
  diffNewlyFilled,
  diffNewlyFilledQuestions,
} from '@/lib/app/questionnaire/panel/newly-filled';
import { buildCorrectionTargets } from '@/lib/app/questionnaire/panel/correction-targets';
import { ModeToggle, type ToggleItem } from '@/components/app/questionnaire/mode-toggle';
import { QuestionnaireSplash } from '@/components/app/questionnaire/intro/questionnaire-splash';
import { PersonaPicker } from '@/components/app/questionnaire/persona/persona-picker';
import {
  CurrentInterviewerChip,
  PersonaSwitcherModal,
} from '@/components/app/questionnaire/persona/interviewer-switcher';
import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';
import { EarlyFinishControl } from '@/components/app/questionnaire/lifecycle/early-finish-control';
import { FinalCheckModal } from '@/components/app/questionnaire/lifecycle/final-check-modal';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';
import { TranscriptDownload } from '@/components/app/questionnaire/lifecycle/transcript-download';
import type {
  QuestionnaireChatStatus,
  QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';
import type { PresentationMode, ReasoningPlacement } from '@/lib/app/questionnaire/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import { ProfileCaptureGate } from '@/components/app/questionnaire/profile/profile-capture-gate';
import { HandoffCard } from '@/components/app/questionnaire/experiences/handoff-card';
import { StitchedContinuation } from '@/components/app/questionnaire/experiences/stitched-continuation';
import { useStitchedHistory } from '@/lib/hooks/use-stitched-history';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';
import { API } from '@/lib/api/endpoints';

/**
 * Which surface the carousel is showing. `intro`, `capture`, and `persona` are pre-chat "gates" that
 * only exist when their feature is on; all defer the opening LLM turn until the respondent moves past
 * them. `capture` is additionally BLOCKING — unlike intro/persona (which the respondent may swipe past
 * freely), the respondent cannot advance beyond it until the profile form is submitted and validated.
 */
type WorkspaceView = 'intro' | 'capture' | 'persona' | 'chat' | 'form';

export interface SessionWorkspaceProps {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** Seed the transcript (e.g. a resume greeting). */
  initialTurns?: QuestionnaireTurn[];
  /**
   * Preview Turn Inspector (admin-only): seed the drawer's per-turn traces on resume so a reload
   * re-hydrates it. Empty/omitted for a real respondent — the transcript route only replays these
   * for a preview session with the inspector toggle on.
   */
  initialInspectorTurns?: TurnInspectorData[];
  /** Start in a blocking status (e.g. an already-paused session). */
  initialStatus?: QuestionnaireChatStatus;
  /** SSR-resolved answer-panel view (authenticated path); omit for anonymous. */
  initialPanel?: AnswerPanelView;
  /** SSR-resolved lifecycle status view (authenticated path); omit for anonymous. */
  initialStatusView?: SessionStatusView;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
  /** Show the attachment affordance (gated server-side on the attachment-input flag). */
  attachmentInputEnabled?: boolean;
  /**
   * Proactively stream the first question once on mount (a "kickoff" turn) so the respondent
   * never has to send a message to begin. Set for fresh sessions only — NOT on resume, where
   * re-asking on every refresh would burn an LLM turn per load.
   */
  autoStart?: boolean;
  /**
   * How the respondent completes the session (P-presentation): `chat`, raw `form`, or `both`
   * (toggle). Defaults to `chat`. Drives which surface renders below the lifecycle bar.
   */
  presentationMode?: PresentationMode;
  /** SSR-resolved full form view (forForm) for `form`/`both` modes; omit for anonymous. */
  initialFormView?: AnswerPanelView;
  /**
   * Live "watch it think" reasoning placement (demo feature) — `overlay` | `inline`, or
   * `undefined`/null when the version toggle is off. The page resolves the gate server-side
   * and passes the effective placement; the chat renders nothing
   * when it's absent.
   */
  reasoningPlacement?: ReasoningPlacement | null;
  /** "Animated" placement: base dwell (ms) the reasoning summary stays open for up to two steps. */
  reasoningDwellMs?: number;
  /** "Animated" placement: extra dwell (ms) per reasoning step beyond two. */
  reasoningPerItemMs?: number;
  /**
   * Inline answer correction (Variant B): show the "fix this answer" gesture beneath the most-recent
   * chat turn and on the answer-panel rows, letting the respondent correct a just-captured answer
   * without sending a fresh turn. Per-questionnaire toggle (default off); the page resolves it from the
   * version config. Never shown in the read-only admin viewer.
   */
  inlineCorrectionEnabled?: boolean;
  /**
   * Read-only replay (admin session viewer): render just the transcript — no composer, lifecycle
   * bar, answer panel, form, or completion screen — and make the panel/lifecycle hooks inert (no
   * fetches), since the viewing admin holds no respondent credential. The respondent surface never
   * sets this. For a continuable preview session the viewer omits this and passes a minted
   * `accessToken` instead, getting the full interactive workspace.
   */
  readOnly?: boolean;
  /**
   * Resolved respondent intro (F-intro). When enabled, the splash rides the carousel as an `intro`
   * view rather than a separate pre-gate — the respondent slides between it and the conversation via
   * the toggle, and can return to re-read it any time. On a FRESH session (`autoStart`) the workspace
   * opens on the intro and defers the LLM kickoff until they first leave it, so — exactly as with the
   * old pre-gate — no turn is spent before they begin. On a RESUME the conversation is already on
   * screen, so it opens there with the intro one tap away. A disabled intro or the read-only viewer
   * omit the surface entirely.
   */
  intro?: ResolvedSessionIntro | null;
  /**
   * Selectable interviewer personas (F-persona). When enabled, a "Choose your interviewer" surface
   * rides the carousel just before the chat, and a switcher in the lifecycle bar reopens it mid-run.
   * Like the intro, it's a pre-chat gate on a fresh session: the workspace opens on it (after any
   * intro) and defers the opening LLM turn until the respondent moves through to the conversation, so
   * their chosen persona is in place before the first question streams. Disabled / read-only omit it.
   */
  personas?: ResolvedSessionPersonas | null;
  /**
   * Respondent profile capture (F-capture). When the version has a `form`-placement subset of
   * `profileFields` (`formFields`) and is NOT anonymous, a BLOCKING form gate rides the carousel just
   * after the intro and before the persona/chat: the respondent cannot advance (and the opening LLM
   * turn is deferred) until they submit valid details. `satisfied` (a snapshot already exists on
   * resume, or there is no form subset) skips the gate. A hybrid version's conversational fields aren't
   * here — the interviewer gathers those in-chat. Null for an anonymous version — that path stays
   * PII-free and never gates. The read-only admin viewer omits it.
   */
  capture?: ResolvedSessionCapture | null;
}

// Static label/icon lookup for the carousel toggle — module-scoped so it isn't
// reallocated on every render (the workspace re-renders on each streaming token).
const VIEW_META: Record<WorkspaceView, { label: string; Icon: typeof BookOpen }> = {
  intro: { label: 'Intro', Icon: BookOpen },
  capture: { label: 'Details', Icon: ClipboardList },
  persona: { label: 'Interviewer', Icon: Drama },
  chat: { label: 'Chat', Icon: MessageSquare },
  form: { label: 'Form', Icon: ListChecks },
};

export function SessionWorkspace({
  sessionId,
  accessToken,
  initialTurns,
  initialInspectorTurns,
  initialStatus,
  initialPanel,
  initialStatusView,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  autoStart = false,
  presentationMode = 'both',
  initialFormView,
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  inlineCorrectionEnabled = false,
  readOnly = false,
  intro = null,
  personas = null,
  capture = null,
}: SessionWorkspaceProps) {
  const showChat = presentationMode === 'chat' || presentationMode === 'both';
  const showForm = presentationMode === 'form' || presentationMode === 'both';
  // The intro recap rides the carousel whenever the version enables it — on a fresh session AND on a
  // resume, so a returning respondent can still slide back to re-read it. (`autoStart` only governs
  // whether we LAND on it and defer the kickoff; see below.) Never in the read-only admin viewer.
  const showIntro = Boolean(intro?.enabled && !readOnly);
  // The persona picker rides the carousel just before the chat whenever selection is enabled (and the
  // chat exists to steer). Like the intro it's a pre-chat gate on a fresh session. Never read-only.
  // The `indicator` switcher drops the carousel page entirely — the respondent picks via the in-chat
  // chip + modal instead — so only `page` / `both` put the picker on the carousel.
  const showPersona = Boolean(
    personas?.enabled && showChat && !readOnly && personas.switcher !== 'indicator'
  );
  // The profile capture form-gate rides the carousel between the intro and the persona/chat, whenever
  // the version has a form-placement subset to collect and hasn't already (a resume with an existing
  // snapshot, an all-conversational/anonymous version, or no fields leaves `satisfied`/empty/`null` so
  // the gate is absent). `formFields` is only the `form`-placement subset — a hybrid version's
  // conversational fields are gathered in-chat, never here. BLOCKING: the respondent can't advance past
  // it until it's submitted (see `goToView`) — and the LLM kickoff is deferred until then. Never in the
  // read-only admin viewer.
  const showCapture = Boolean(
    capture && capture.formFields.length > 0 && !capture.satisfied && !readOnly
  );
  // The in-chat "Interviewer: {name} · Change" chip — shown for the `indicator` and `both` switchers.
  const showInterviewerChip = Boolean(
    personas?.enabled &&
    showChat &&
    !readOnly &&
    (personas.switcher === 'indicator' || personas.switcher === 'both')
  );

  // The pre-chat gates, in carousel order: intro first (read the brief), then capture (enter details),
  // then persona (pick a voice). The workspace lands on the FIRST present gate on a fresh session and
  // defers the kickoff until the respondent moves past every gate to the conversation. A resume lands
  // on the conversation instead.
  const firstGate: WorkspaceView | null = showIntro
    ? 'intro'
    : showCapture
      ? 'capture'
      : showPersona
        ? 'persona'
        : null;
  const openOnGate = firstGate !== null && autoStart;

  // The carousel surfaces, left→right, present-only. At least one of chat/form always exists
  // (presentationMode is chat | form | both), so this is never empty. Capture sits after intro and
  // before persona so the required details are in hand before a voice is chosen or a turn streams.
  const views = useMemo<WorkspaceView[]>(() => {
    const list: WorkspaceView[] = [];
    if (showIntro) list.push('intro');
    if (showCapture) list.push('capture');
    if (showPersona) list.push('persona');
    if (showChat) list.push('chat');
    if (showForm) list.push('form');
    return list;
  }, [showIntro, showCapture, showPersona, showChat, showForm]);

  // Active surface. A fresh session opens on the first gate (intro, else persona); everything else
  // opens on the primary surface (a resume keeps the gates reachable via the toggle).
  const [activeView, setActiveView] = useState<WorkspaceView>(
    openOnGate && firstGate ? firstGate : presentationMode === 'form' ? 'form' : 'chat'
  );
  // Has the respondent moved past the pre-chat gates at least once? Gates the LLM kickoff so no turn
  // is spent while they're still reading the intro or choosing a persona. Initialises `true` whenever
  // we don't open on a gate (resume, or no gates), preserving "open immediately" for those paths.
  const [started, setStarted] = useState(!openOnGate);
  // Has the respondent submitted the blocking capture gate? Initialises `true` when there's no gate,
  // so non-capture sessions behave exactly as before. Gates BOTH forward navigation past the capture
  // surface (see `goToView`) and the LLM kickoff (below), so no turn streams while the form is open.
  const [captureDone, setCaptureDone] = useState(!showCapture);
  // The blocking window: on the unsubmitted capture gate, forward moves and the surface toggle are
  // suppressed so the respondent can't skip required details.
  const captureBlocking = showCapture && !captureDone;
  // Data-slot mode: the slot keys the latest turn filled, fed to the panel so it can scroll to them
  // and step through. Computed by diffing the previous panel snapshot against each new one (the
  // stream never tells the client a turn ordinal, so a diff is the reliable signal). `prevPanelRef`
  // holds the prior snapshot; the first (SSR/seed) view seeds it silently and emits nothing.
  const prevPanelRef = useRef<AnswerPanelView | null>(null);
  const [newlyFilledKeys, setNewlyFilledKeys] = useState<readonly string[]>([]);
  // The slot keys the most-recent turn filled, in BOTH modes — drives the inline-correction targets
  // (Variant B). Distinct from `newlyFilledKeys` (data-slot-only, which drives the panel's scroll +
  // stepper); the question-mode panel keeps its prior behaviour while the chat strip still learns the
  // just-captured questions.
  const [lastTurnFilledKeys, setLastTurnFilledKeys] = useState<readonly string[]>([]);
  // Mobile "Review answers" bottom-sheet (below `lg`, where the side panel is hidden).
  const [reviewOpen, setReviewOpen] = useState(false);
  // The `indicator`-mode "change your interviewer" modal (no carousel persona page in that switcher).
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  // Both reads refetch on each clean turn-settle. The stream reads its `onTurnSettled`
  // through a ref, so routing the refetches through refs here breaks the declaration
  // cycle (stream needs the settle handler; the hooks below need the stream's applyStatus).
  const panelRefetchRef = useRef<(() => void) | null>(null);
  const lifecycleRefetchRef = useRef<(() => void) | null>(null);

  // Final completion sweep (F7.3): the held reconciliation probe, when a submit/early-finish is held
  // on a contradiction. Its presence swaps the submit affordance to "finish anyway" (so a re-click is
  // an escape, not a re-sweep loop). `early` records which submit path was held so "finish anyway"
  // posts the matching flag. The final-check modal's open state is tracked SEPARATELY (below) — the two
  // are orthogonal: dismissing the modal must not disturb `early`, or "finish anyway" would 409.
  const [heldProbe, setHeldProbe] = useState<{ text: string; early: boolean } | null>(null);
  // Whether the early-finish final-check modal is showing. Set on an early held submit; cleared on
  // "clarify in chat" (which leaves `heldProbe` intact so the affordance stays "finish anyway").
  const [finalCheckOpen, setFinalCheckOpen] = useState(false);

  const onTurnSettled = useCallback(() => {
    panelRefetchRef.current?.();
    lifecycleRefetchRef.current?.();
    // A settled turn is the respondent answering the probe (or moving on) — the server resolves the
    // parked contradiction, so drop the held state; the next submit re-sweeps cleanly.
    setHeldProbe(null);
    setFinalCheckOpen(false);
  }, []);

  const panel = useAnswerPanel({
    sessionId,
    accessToken,
    initialView: initialPanel,
    enabled: !readOnly,
  });

  const stream = useQuestionnaireSessionStream({
    sessionId,
    accessToken,
    initialTurns,
    initialInspectorTurns,
    initialStatus,
    onTurnSettled,
  });

  // A held submit records the probe as a turn server-side; drop it into the live transcript now so the
  // respondent can answer it in the chat, and stash it to drive the affordance swap + the modal.
  const { appendAgentTurn } = stream;
  const onHeld = useCallback(
    (probe: { text: string; slotKeys: string[]; notice?: string }, opts: { early: boolean }) => {
      // Append with the SAME contradiction notice the server persisted on the turn, so the live
      // transcript matches a post-reload replay (the "I noticed something" box, not bare probe text).
      appendAgentTurn(
        probe.text,
        probe.notice ? [{ code: 'contradiction', message: probe.notice }] : undefined
      );
      setHeldProbe({ text: probe.text, early: opts.early });
      if (opts.early) setFinalCheckOpen(true);
    },
    [appendAgentTurn]
  );

  const lifecycle = useSessionLifecycle({
    sessionId,
    accessToken,
    initialView: initialStatusView,
    applyStatus: stream.applyStatus,
    onHeld,
    enabled: !readOnly,
  });

  // Raw form surface (P-presentation). Inert in chat-only mode (`enabled: false` → no fetch).
  // A save refreshes the lifecycle so coverage / submit-readiness reflect the new answer.
  const onFormSaved = useCallback(() => {
    lifecycleRefetchRef.current?.();
  }, []);
  const form = useFormAnswers({
    sessionId,
    accessToken,
    initialView: initialFormView,
    enabled: showForm && !readOnly,
    onSaved: onFormSaved,
  });

  // Proactive opening: stream the first question on a fresh session so the agent opens without
  // the respondent typing. State-based guard (not a one-shot ref): fire only while the session
  // is settled (`idle`) and just the greeting turn is present. `streamTurn` flips status to
  // `streaming` synchronously, so the next render's guard blocks a duplicate; once the first
  // question arrives (turns grows past the greeting) it stops. This self-heals React 19
  // StrictMode's dev double-invoke — whose effect-cleanup aborts the first kickoff, after which
  // the hook recovers status to `idle` with no question — by simply firing again on the remount.
  const kickoff = stream.kickoff;
  const streamStatus = stream.status;
  const turnCount = stream.turns?.length ?? 0;
  useEffect(() => {
    if (!autoStart) return;
    if (!started) return; // intro present and not yet left — hold the opening turn
    if (captureBlocking) return; // required details not yet submitted — hold the opening turn
    if (!showChat) return; // form-only mode never opens a chat turn
    if (streamStatus !== 'idle') return;
    if (turnCount > 1) return;
    void kickoff();
  }, [autoStart, started, captureBlocking, showChat, kickoff, streamStatus, turnCount]);

  // Keep the settle targets current without touching refs during render. The stream calls
  // `onTurnSettled` (and thus reads these) only after a turn settles — well after this effect.
  useEffect(() => {
    panelRefetchRef.current = panel.refetch;
    lifecycleRefetchRef.current = lifecycle.refetch;
  });

  // The mobile review sheet only makes sense below `lg` (where the side panel is hidden). If the
  // viewport grows past `lg` while it's open, close it so it doesn't linger over the now-visible
  // side panel. The trigger is already `lg:hidden`; this just covers the live-resize edge.
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const close = () => {
      if (mq.matches) setReviewOpen(false);
    };
    close();
    mq.addEventListener('change', close);
    return () => mq.removeEventListener('change', close);
  }, []);

  // Detect the data slots the latest refetch filled (data-slot mode only). On the first view we just
  // seed the ref — never auto-scroll the seeded/SSR snapshot. Each later view diffs against the prior
  // one; a new turn's fills replace the previous set (the panel restarts its stepper on identity).
  const panelView = panel.view;
  useEffect(() => {
    const prev = prevPanelRef.current;
    prevPanelRef.current = panelView ?? null;
    if (panelView == null) return;
    // Always publish — a later turn that fills nothing must CLEAR the prior turn's keys so a stale
    // stepper footer / correction strip doesn't linger. The functional update keeps the empty array
    // referentially stable (so effects keyed on the serialized keys don't needlessly re-run).
    const publish = (set: typeof setLastTurnFilledKeys) => (filled: string[]) =>
      set((p) => (p.length === 0 && filled.length === 0 ? p : filled));
    if (panelView.dataSlotGroups) {
      const filled = diffNewlyFilled(prev, panelView);
      publish(setNewlyFilledKeys)(filled);
      publish(setLastTurnFilledKeys)(filled);
    } else {
      // Question mode: the panel's scroll/stepper stays off (unchanged), but the chat strip still
      // learns which questions the latest turn captured.
      publish(setLastTurnFilledKeys)(diffNewlyFilledQuestions(prev, panelView));
    }
  }, [panelView]);

  const handleRevisit = useCallback(
    (slot: PanelSlotView) => {
      if (!stream.canSend) return;
      void stream.sendMessage(`I'd like to revisit my answer to: ${slot.prompt}`);
    },
    [stream]
  );

  // Data-slot "Incorrect?" affordance: the respondent flags a captured reading as off, and we steer
  // the agent (via a normal turn) to probe deeper into that one slot rather than move on. We send the
  // slot's current reading so the agent knows exactly what to re-open.
  const handleRefine = useCallback(
    (slot: DataSlotPanelSlot) => {
      if (!stream.canSend) return;
      const current = slot.paraphrase ? ` Right now you have it as: “${slot.paraphrase}”.` : '';
      void stream.sendMessage(
        `I don't think “${slot.name}” is quite right.${current} Could you ask me a more detailed ` +
          `question so we can get it correct?`
      );
    },
    [stream]
  );

  // Carousel navigation. Leaving the pre-chat gates (to a real surface) marks the session started,
  // which releases the deferred kickoff. Switching TO the form re-seeds it so chat-inferred answers
  // appear; switching TO chat refetches the panel so it reflects the form's edits.
  const goToView = useCallback(
    (view: WorkspaceView) => {
      // Blocking capture gate: never advance PAST it until it's submitted. Guards every nav vector
      // (toggle, swipe, arrow keys, the intro's Proceed) at once; the gate's own submit uses
      // `handleCaptureSubmitted` (below), which advances directly and bypasses this. Backward moves
      // (to the intro) and re-selecting the capture surface itself stay allowed.
      if (showCapture && !captureDone) {
        const captureIdx = views.indexOf('capture');
        if (captureIdx !== -1 && views.indexOf(view) > captureIdx) return;
      }
      setActiveView(view);
      // Reaching a real surface (past the intro/capture/persona gates) releases the deferred kickoff.
      if (view !== 'intro' && view !== 'capture' && view !== 'persona') setStarted(true);
      if (view === 'form') form.refresh();
      else if (view === 'chat') panel.refetch();
    },
    [form, panel, showCapture, captureDone, views]
  );

  // The capture gate was submitted (server-validated + snapshot persisted). Mark it done and slide to
  // the next surface — advancing DIRECTLY (not via `goToView`, whose forward-lock still reads the
  // pre-flip `captureDone`). The next surface is the persona picker if present, else the primary
  // conversation/form. CRITICAL: only release the kickoff (`started`) when the next surface is NOT a
  // further gate — if a persona picker follows, `started` must stay false so the opening turn is still
  // deferred until the respondent picks a voice and moves to the chat (else it streams behind the
  // picker, with the DEFAULT persona). Mirrors `goToView`'s gate rule.
  const handleCaptureSubmitted = useCallback(() => {
    setCaptureDone(true);
    const next = views.find((v) => v !== 'intro' && v !== 'capture') ?? 'chat';
    if (next !== 'persona') setStarted(true);
    setActiveView(next);
    if (next === 'form') form.refresh();
    else if (next === 'chat') panel.refetch();
  }, [views, form, panel]);

  // Selectable interviewer persona: the respondent's current choice, seeded from the resolved menu.
  // Persisted on pick so the turn loop reads it (`resolveEffectiveTone`). Fails soft — a persona is an
  // enhancement, never a blocker: a failed write leaves the local highlight and the server default
  // still applies. The picker rides the carousel, so the ModeToggle's "Interviewer" segment is also
  // the mid-run switcher — no separate control needed.
  const [selectedPersonaKey, setSelectedPersonaKey] = useState<string | null>(
    personas?.selectedPersonaKey ?? null
  );
  const choosePersona = useCallback(
    (key: string) => {
      setSelectedPersonaKey(key);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) headers['X-Session-Token'] = accessToken;
      void fetch(API.APP.QUESTIONNAIRE_SESSIONS.persona(sessionId), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ personaKey: key }),
      }).catch(() => {
        /* fail soft — local highlight stays; the server default applies if the write didn't land */
      });
    },
    [accessToken, sessionId]
  );

  // The interviewer currently governing the session: the respondent's explicit choice, else the
  // configured default. Drives the in-chat chip's label (`indicator` / `both` switchers).
  const currentPersonaKey = selectedPersonaKey ?? personas?.defaultPersonaKey ?? null;
  const currentPersonaLabel =
    personas?.personas.find((p) => p.key === currentPersonaKey)?.label ?? 'Interviewer';
  // Pressing the chip: `both` slides the carousel back to the picker page; `indicator` (no page) opens
  // the modal picker instead.
  const onChangeInterviewer = useCallback(() => {
    if (personas?.switcher === 'both') goToView('persona');
    else setPersonaModalOpen(true);
  }, [personas?.switcher, goToView]);

  // Step one surface along the carousel (clamped at the ends), the shared move behind the toggle,
  // the swipe gesture and the arrow keys. `delta` is +1 (toward the next surface) or -1 (previous).
  const activeIndex = Math.max(0, views.indexOf(activeView));
  const goRelative = useCallback(
    (delta: number) => {
      const next = views[views.indexOf(activeView) + delta];
      if (next) goToView(next);
    },
    [views, activeView, goToView]
  );

  // Swipe/drag the carousel with a horizontal touch or trackpad gesture. The track follows the
  // gesture live (a small nudge slides a little and springs back, signalling it's swipeable); a
  // fuller gesture past the threshold changes surface. Forward (right→left) advances, back (left→
  // right) steps back; the ends rubber-band. Vertical scrolls are left untouched.
  const carouselRef = useRef<HTMLDivElement>(null);
  const measureWidth = useCallback(() => carouselRef.current?.clientWidth ?? 0, []);
  const swipe = useHorizontalSwipe({
    onCommitNext: () => goRelative(1),
    onCommitPrev: () => goRelative(-1),
    // Rubber-band (don't commit) a forward gesture on the unsubmitted capture gate — the gesture
    // physically can't skip required details. `goToView`'s lock is the belt to this suspenders.
    canNext: activeIndex < views.length - 1 && !(activeView === 'capture' && !captureDone),
    canPrev: activeIndex > 0,
    getWidth: measureWidth,
  });

  // Wheel (trackpad / Magic Mouse) is bound natively with `passive: false` so a consumed horizontal
  // gesture can `preventDefault` — otherwise macOS hijacks the same two-finger swipe for browser
  // back/forward navigation. Re-binds when the frame mounts (views.length crosses 1) or the handler
  // identity changes (edge availability shifts).
  const handleWheel = swipe.handleWheel;
  const multiView = views.length > 1;
  useEffect(() => {
    const el = carouselRef.current;
    if (!el || !multiView) return;
    const onWheel = (e: WheelEvent) => {
      if (handleWheel(e.deltaX, e.deltaY)) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [handleWheel, multiView]);

  // Keyboard parity with the swipe gesture: ←/→ step between surfaces. Ignored while typing (the
  // chat composer / any field owns its own caret movement) and when a modifier is held (so browser
  // shortcuts like ⌘← still work). Only active once there's more than one surface to move between.
  useEffect(() => {
    if (views.length < 2 || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el?.isContentEditable ||
        el?.tagName === 'INPUT' ||
        el?.tagName === 'TEXTAREA' ||
        el?.tagName === 'SELECT'
      ) {
        return;
      }
      e.preventDefault();
      goRelative(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [views.length, goRelative]);

  /* ---------------------------------------------------------------------- */
  /* Experiences (P15.2 wiring, P15.3 stitched)                              */
  /* ---------------------------------------------------------------------- */

  // Run membership rides on the LIFECYCLE STATUS VIEW, not on the submit response. The submit
  // response is seen once; a respondent who reloads a completed leg — or comes back to the tab an
  // hour later — would otherwise land on the terminal completion screen and never learn the
  // journey continues. `null` for an ordinary standalone session, which is almost all of them.
  const router = useRouter();
  const experience = lifecycle.view?.experience ?? null;
  const stitched = experience?.continuityMode === 'stitched';

  // Earlier legs, replayed above the live conversation. Only fetched when there is something to
  // fetch: stitched, and not the entry leg. Never in the read-only admin viewer, which has no
  // respondent credential and whose own surface already shows one session at a time.
  const stitchedHistory = useStitchedHistory({
    runId: experience?.runId ?? null,
    sessionId,
    sessionToken: accessToken,
    enabled: Boolean(stitched && !readOnly && (experience?.ordinal ?? 0) > 0),
  });

  // A stitched handoff that ended the journey rather than continuing it. Held here so the
  // component can fall through to the ordinary completion screen once the poll settles.
  const [stitchedOutcome, setStitchedOutcome] = useState<RunPollState | null>(null);

  // How this surface moves into the next leg. Derived here rather than passed in: the page
  // rendering this workspace is a SERVER component, so it cannot hand down a function at all.
  //
  // The two surfaces differ in a way that is easy to get silently wrong. The authenticated one
  // addresses each session by id, so continuing NAVIGATES. The no-login surface sits on
  // `/x/<publicRef>` — one stable address for the whole journey — where the URL for leg B is the
  // URL already in the address bar. `router.push` there is a no-op, so continuing must REFRESH,
  // which re-runs the server component and resolves the run to its new current leg.
  const onContinue = useCallback(
    (nextSessionId: string) => {
      if (experience?.publicRef && accessToken) {
        router.refresh();
        return;
      }
      router.push(`/questionnaires/${nextSessionId}`);
    },
    [router, experience?.publicRef, accessToken]
  );

  const onConclude = useCallback(() => {
    // The run-level report is F15.4; until it exists the last leg's own respondent report is the
    // closest honest thing, and it lives on the completion screen this falls through to.
    setStitchedOutcome({ state: 'conclude', reason: 'selector', message: '' });
  }, []);

  // Whether this surface can host a handoff at all. The no-login path needs the stable address;
  // without a publicRef (a pre-column run) there is nowhere to send the respondent, and showing a
  // Continue button that goes nowhere is worse than falling through to the completion screen.
  const canHandOff = accessToken ? Boolean(experience?.publicRef) : true;

  // The label the live leg's divider carries — null when the author chose the seamless marker,
  // undefined when this is not a stitched leg at all (no dividers anywhere).
  const stitchedSeamLabel = stitched
    ? experience?.seamMarker === 'none'
      ? null
      : (experience?.stepTitle ?? null)
    : undefined;

  // Read-only viewer (admin): just the transcript, no chrome. Rendered after all hooks so the
  // panel/lifecycle/form hooks (inert via `enabled: false`) still obey the rules of hooks. A
  // completed session is shown as its conversation here, not the respondent's completion screen.
  if (readOnly) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <QuestionnaireChat
          sessionId={sessionId}
          stream={stream}
          readOnly
          reasoningPlacement={reasoningPlacement}
          reasoningDwellMs={reasoningDwellMs}
          reasoningPerItemMs={reasoningPerItemMs}
          className="min-h-0 flex-1"
        />
      </div>
    );
  }

  // Submitted → the conversation/form is done; show the confirmation in place of the workspace.
  // Either the in-session submit flipped the stream to `completed`, OR the session was already
  // completed when this surface loaded (a resume / reopen) — the lifecycle status read is the
  // authority for the latter. Without this second arm a reopened completed session would drop
  // into the chat and, on any further send, hit the "session no longer active" panel; instead it
  // stays on the calm completion screen where the report download lives.
  if (stream.status === 'completed' || lifecycle.view?.status === 'completed') {
    // A leg of an experience is NOT the end of anything yet — the selector may still route the
    // respondent onward. Before P15.3 this arm was unconditional, so a completed leg dead-ended on
    // the completion screen and the whole run machinery behind it was unreachable.
    //
    // `stitchedOutcome` is how the stitched branch falls through: once the fork resolves to an
    // ending (or the handoff fails) there is nothing left to continue into, and the ordinary
    // completion screen — with its report and download — is the right destination.
    if (experience && canHandOff && !stitchedOutcome) {
      if (stitched) {
        return (
          <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
            <StitchedContinuation
              runId={experience.runId}
              sessionId={sessionId}
              sessionToken={accessToken}
              onContinue={onContinue}
              onSettled={setStitchedOutcome}
            />
          </div>
        );
      }
      return (
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
          <HandoffCard
            runId={experience.runId}
            sessionId={sessionId}
            sessionToken={accessToken}
            onContinue={onContinue}
            onConclude={onConclude}
          />
        </div>
      );
    }

    return (
      <SessionComplete
        sessionId={sessionId}
        accessToken={accessToken}
        answeredCount={lifecycle.view?.completion.answeredCount ?? null}
        refRaw={lifecycle.view?.ref ?? null}
        // Experiences (F15.4b): a leg shows the RUN's report — the journey's summary — because the
        // leg itself no longer generates one. Null for a standalone session.
        runId={experience?.runId ?? null}
        // The last-settled answer panel feeds the "while your report is being prepared" cycler — the
        // respondent sees their own captured positions echoed back instead of a bare spinner.
        captured={panel.view ?? null}
      />
    );
  }

  // A blocked session (respondent-paused, budget-capped, expired) is read-only for the form.
  const formBlocked =
    stream.status === 'not_active' ||
    stream.status === 'cost_capped' ||
    stream.status === 'expired';

  // Inline answer correction (Variant B). Allowed in the same interactive window the form accepts
  // edits (active, non-terminal) — the write goes through `PUT …/answers`, which rejects a non-active
  // session anyway. `correction` is the bundle the panel rows + chat strip share; `undefined` hides
  // the gesture entirely (toggle off, read-only viewer, or a blocked session).
  const canCorrect = inlineCorrectionEnabled && !readOnly && !formBlocked;
  const correction = canCorrect
    ? { sessionId, accessToken, onCorrected: onTurnSettled }
    : undefined;
  // The correction targets for the most-recent turn — what the chat strip offers to fix.
  const correctionTargets = canCorrect
    ? buildCorrectionTargets(panel.view, lastTurnFilledKeys)
    : [];

  // Short progress label for the mobile "Review answers" trigger, mirroring the panel's own
  // ProgressHeading: percent in data-slot mode, "N of M" in question mode.
  const reviewCountLabel = panel.view
    ? panel.view.progressPercent !== undefined
      ? `${panel.view.progressPercent}% complete`
      : `${panel.view.answeredCount} of ${panel.view.totalCount}`
    : null;

  // The carousel toggle's segments, derived from the present surfaces (left→right). Shown whenever
  // there's more than one surface to move between — chat↔form, or intro alongside either.
  const toggleItems: ToggleItem[] = views.map((id) => ({ id, ...VIEW_META[id] }));
  // Suppressed entirely while the blocking capture gate is open — the toggle would otherwise offer a
  // one-tap skip past required details (and `ModeToggle` has no per-segment disabled state). The intro
  // Proceed button and the gate's own submit drive the flow until the details are in.
  const showToggle = views.length > 1 && !captureBlocking;

  // Right-cluster controls: the surface toggle and the mobile answer-review trigger. Kept
  // `undefined` when neither applies so the lifecycle strip still collapses to nothing on a plain
  // form-only session (the bar renders the strip whenever `trailing` is present).
  const showReviewTrigger =
    showChat && activeView !== 'intro' && activeView !== 'capture' && activeView !== 'persona'; // the answer panel only rides the chat surface
  // The interviewer chip only makes sense on the chat surface (not while reading the intro / on the
  // form / on the picker page itself).
  const showChipHere = showInterviewerChip && activeView === 'chat';
  const trailingControls =
    showToggle || showReviewTrigger || showChipHere ? (
      <>
        {showChipHere && (
          <CurrentInterviewerChip
            label={currentPersonaLabel}
            onChange={onChangeInterviewer}
            busy={stream.status === 'streaming'}
          />
        )}
        {showToggle && (
          <ModeToggle
            value={activeView}
            items={toggleItems}
            onChange={(v) => goToView(v as WorkspaceView)}
          />
        )}
        {showReviewTrigger && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Pill shape echoes the ModeToggle so the two read as one control group when they
            // share a wrapped row on mobile. Hidden once the side panel returns (`lg`).
            className="rounded-full lg:hidden"
            onClick={() => setReviewOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={reviewOpen}
            aria-label={`Review answers${reviewCountLabel ? `, ${reviewCountLabel}` : ''}`}
          >
            <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/* Keep the word on normal mobile; only ≤360px collapse to the icon alone. The count is
                redundant with the top progress bar, so it stays a ≥sm nicety. `aria-label` keeps the
                control named when it's icon-only. */}
            <span className="max-[360px]:hidden">Review answers</span>
            {reviewCountLabel && (
              <span className="text-muted-foreground ml-1.5 hidden sm:inline">
                · {reviewCountLabel}
              </span>
            )}
          </Button>
        )}
      </>
    ) : undefined;

  // Completion affordance, by precedence: the agent's full submit offer wins (the session is
  // genuinely "done enough"); otherwise the respondent-controlled early-finish escape hatch shows
  // once unlocked. Shared verbatim by the chat and form surfaces.
  // While a final-check probe is held, re-clicking submit/finish is the "finish anyway" escape (skip
  // the sweep) rather than a re-sweep that would just hold again on the same still-unresolved conflict.
  const doSubmit = () =>
    void (heldProbe ? lifecycle.finishAnyway(heldProbe.early) : lifecycle.submit());
  const doFinishEarly = () =>
    void (heldProbe ? lifecycle.finishAnyway(heldProbe.early) : lifecycle.finishEarly());
  const completionAffordance = lifecycle.canSubmit ? (
    <CompletionOffer onSubmit={doSubmit} busy={lifecycle.busy} />
  ) : lifecycle.canFinishEarly ? (
    <EarlyFinishControl onFinish={doFinishEarly} busy={lifecycle.busy} />
  ) : null;

  const chatSurface = (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]">
      <div className="flex min-h-0 flex-col gap-3">
        {completionAffordance}
        <QuestionnaireChat
          sessionId={sessionId}
          accessToken={accessToken}
          stream={stream}
          voiceInputEnabled={voiceInputEnabled}
          attachmentInputEnabled={attachmentInputEnabled}
          reasoningPlacement={reasoningPlacement}
          reasoningDwellMs={reasoningDwellMs}
          reasoningPerItemMs={reasoningPerItemMs}
          // Fresh sessions (autoStart) type the seeded greeting in, like a streamed reply;
          // resumes render their history instantly.
          animateOpening={autoStart}
          correctionTargets={correctionTargets}
          onCorrected={onTurnSettled}
          stitchedHistory={stitchedHistory}
          stitchedSeamLabel={stitchedSeamLabel}
          className="min-h-0 flex-1"
        />
      </div>
      <AnswerSlotPanel
        view={panel.view}
        loading={panel.loading}
        onRevisit={handleRevisit}
        canRevisit={stream.canSend}
        onRefine={handleRefine}
        newlyFilledKeys={newlyFilledKeys}
        correction={correction}
        className="hidden lg:flex"
      />
    </div>
  );

  const formSurface = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {completionAffordance}
      <QuestionnaireForm
        view={form.view}
        loading={form.loading}
        values={form.values}
        editedKeys={form.editedKeys}
        statuses={form.statuses}
        saveState={form.saveState}
        lastSavedAt={form.lastSavedAt}
        onChange={form.setValue}
        onFlush={form.flush}
        disabled={formBlocked}
        className="min-h-0 flex-1"
      />
    </div>
  );

  // The intro recap as a carousel surface. Proceeding slides to the first real surface (chat, or
  // form in a form-only session), which marks the session started and releases the kickoff.
  const introSurface =
    showIntro && intro ? (
      <QuestionnaireSplash
        intro={intro}
        // "Continue" only once a real answer exists — a merely-opened/resumed session at 0% still
        // reads "Begin" (the workspace's `started` flag governs the kickoff, not this label).
        inProgress={(lifecycle.view?.completion.answeredCount ?? 0) > 0}
        // The intro CTA leads to whatever rides next, not always straight into the conversation: the
        // capture form ("Continue" to enter details), else the interviewer picker ("Select your
        // interviewer"). The configured begin label then lands on that surface's own CTA.
        proceedLabel={
          showCapture ? 'Continue' : showPersona ? 'Select your interviewer' : undefined
        }
        onProceed={() => goToView(views.find((v) => v !== 'intro') ?? 'chat')}
      />
    ) : null;

  // The profile capture form gate. Submitting validates + persists server-side, then advances to the
  // next surface (persona/chat) via `handleCaptureSubmitted`, which also releases the deferred kickoff.
  const captureSurface =
    showCapture && capture ? (
      <ProfileCaptureGate
        sessionId={sessionId}
        accessToken={accessToken}
        fields={capture.formFields}
        // When a persona picker follows, the CTA leads to it; otherwise it begins the conversation.
        proceedLabel={showPersona ? 'Continue' : (intro?.copy.buttonLabel ?? undefined)}
        onSubmitted={handleCaptureSubmitted}
      />
    ) : null;

  // The "Choose your interviewer" surface. Picking persists the choice; Continue slides to the chat
  // (which releases the deferred kickoff, now with the chosen persona already in place server-side).
  // As the last gate before the conversation, its CTA carries the configured begin label ("Begin your
  // conversation") — or "Continue" once the session already has an answer — right-aligned so it reads
  // as the final step of the pre-chat flow.
  const personaSurface =
    showPersona && personas ? (
      <PersonaPicker
        personas={personas.personas}
        selectedKey={selectedPersonaKey}
        defaultKey={personas.defaultPersonaKey}
        onChoose={choosePersona}
        onContinue={() => goToView('chat')}
        // Mirror the intro splash: once a real answer exists the conversation is under way, so the
        // CTA reads "Continue" rather than the configured begin label ("Begin your conversation").
        continueLabel={
          (lifecycle.view?.completion.answeredCount ?? 0) > 0
            ? 'Continue'
            : (intro?.copy.buttonLabel ?? 'Begin your conversation')
        }
        alignEnd
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Final completion sweep (F7.3): the early-finish path surfaces the held probe in a modal over
          the exit action. The normal (mid-conversation) path shows it in the chat instead (no modal),
          so this only opens when the held submit was an early finish. Either way the probe is also a
          chat turn; "Clarify in chat" closes the modal so they answer there. */}
      <FinalCheckModal
        open={finalCheckOpen}
        probeText={heldProbe?.text ?? ''}
        // Just close the modal — leave `heldProbe` (incl. `early`) intact so the still-visible finish
        // affordance keeps working as "finish anyway" with the correct early flag.
        onClarify={() => setFinalCheckOpen(false)}
        onFinishAnyway={() => void lifecycle.finishAnyway(heldProbe?.early ?? true)}
        busy={lifecycle.busy}
      />
      {/* Interviewer switcher modal — the `indicator` switcher's "Change" opens this (there's no
          carousel persona page in that mode). `both` uses the carousel page instead, so this stays
          shut there. Picking persists immediately (fail-soft) and applies from the next turn. */}
      {personas && showInterviewerChip && personas.switcher === 'indicator' && (
        <PersonaSwitcherModal
          open={personaModalOpen}
          onOpenChange={setPersonaModalOpen}
          personas={personas.personas}
          selectedKey={selectedPersonaKey}
          defaultKey={personas.defaultPersonaKey}
          onChoose={choosePersona}
          busy={stream.status === 'streaming'}
        />
      )}
      {/* The chat ↔ form toggle rides the lifecycle strip (no dedicated row) and is always
          visible in "both" mode, so the form escape-hatch reads as ever-present. */}
      <SessionLifecycleBar
        view={lifecycle.view}
        paused={stream.status === 'not_active'}
        busy={lifecycle.busy}
        actionError={lifecycle.actionError}
        canPause={lifecycle.canPause}
        canResume={lifecycle.canResume}
        onPause={() => void lifecycle.pause()}
        onResume={() => void lifecycle.resume()}
        // Offer the transcript download once a real conversation exists (past the opening
        // question) and chat is in play — there's nothing to take away from an empty session.
        download={
          showChat && turnCount > 1 ? (
            <TranscriptDownload sessionId={sessionId} accessToken={accessToken} variant="ghost" />
          ) : undefined
        }
        trailing={trailingControls}
      />

      <AnswerReviewDrawer
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        view={panel.view}
        loading={panel.loading}
        canRevisit={stream.canSend}
        newlyFilledKeys={newlyFilledKeys}
        correction={correction}
        // Revisiting sends the respondent back to chat to re-answer, so dismiss the sheet.
        onRevisit={(slot) => {
          handleRevisit(slot);
          setReviewOpen(false);
        }}
        // Refining likewise sends a turn — close the sheet so the respondent sees the agent's probe.
        onRefine={(slot) => {
          handleRefine(slot);
          setReviewOpen(false);
        }}
      />

      {views.length > 1 ? (
        // Carousel: each surface is an absolutely-positioned cell pinned to the clipped frame
        // (`absolute inset-0` → exactly one frame wide, no flex/percentage width maths to misfire),
        // slid horizontally by its distance from the active surface. The active cell sits at 0; the
        // rest are parked one (or more) frame-widths to the left/right and clipped away. Sliding the
        // toggle re-computes every offset, so the whole set animates as one track.
        //
        // `overflow-clip`, NOT `overflow-hidden`: `hidden` leaves the frame programmatically
        // scrollable, so when an off-screen cell's content grabs focus or calls `scrollIntoView`
        // (the chat composer autofocus, the message auto-scroll), the browser scrolls the frame
        // sideways to "reveal" it and drags the whole carousel off-screen. `clip` clips identically
        // but establishes no scroll container, so nothing can shift it.
        <div
          ref={carouselRef}
          className="relative min-h-0 flex-1 overflow-clip"
          style={{ overscrollBehaviorX: 'contain' }}
          onTouchStart={swipe.onTouchStart}
          onTouchMove={swipe.onTouchMove}
          onTouchEnd={swipe.onTouchEnd}
        >
          {views.map((view, i) => {
            const offset = (i - activeIndex) * 100;
            return (
              <div
                key={view}
                role="tabpanel"
                aria-label={VIEW_META[view].label}
                className={cn(
                  'absolute inset-0 overflow-clip will-change-transform motion-reduce:transition-none',
                  // Animate every settled move (toggle, arrow keys, gesture release) — i.e. whenever the
                  // track is at rest (`dragPx === 0`) or actively springing back (`animating`). Only an
                  // in-progress finger/wheel drag (non-zero `dragPx`, not yet settled) skips the
                  // transition so the surface tracks the gesture 1:1.
                  (swipe.animating || swipe.dragPx === 0) &&
                    'transition-transform duration-300 ease-out'
                )}
                style={{ transform: `translateX(calc(${offset}% + ${swipe.dragPx}px))` }}
                inert={activeView !== view}
              >
                {view === 'intro'
                  ? introSurface
                  : view === 'capture'
                    ? captureSurface
                    : view === 'persona'
                      ? personaSurface
                      : view === 'form'
                        ? formSurface
                        : chatSurface}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1">{showForm ? formSurface : chatSurface}</div>
      )}
    </div>
  );
}
