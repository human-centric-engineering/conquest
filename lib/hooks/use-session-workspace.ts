'use client';

/**
 * useSessionWorkspace — everything the respondent surface *does*, with nothing about how it looks.
 *
 * `SessionWorkspace` used to own both: seven hooks, ~15 pieces of local state, the carousel /
 * swipe / keyboard machinery, and the JSX, in one file. That was survivable while there was
 * exactly one arrangement. It stops being survivable the moment a second layout exists, because
 * every layout would have to re-derive the same gates — and the gates are subtle (a blocking
 * capture form defers the opening LLM turn; releasing it early streams a question behind the
 * persona picker with the wrong voice).
 *
 * So the behaviour lives here, once, and layouts receive the result. Sibling hooks in this
 * directory (`useAnswerPanel`, `useQuestionnaireSessionStream`, `useSessionLifecycle`,
 * `useFormAnswers`, `useStitchedHistory`) are composed by this one; nothing else should call them
 * directly for a respondent surface, or the shared-stream guarantee below is lost.
 *
 * ONE stream, deliberately: the answer panel's "Revisit", the form's saves and the lifecycle
 * actions all push turns through the same loop the conversation uses, and both the panel and the
 * status view refetch whenever a turn settles. Two instances would give a respondent two
 * transcripts that disagree.
 *
 * Returns {@link SessionWorkspaceState}. The one field a caller must branch on first is `phase`:
 * `readOnly`, `handoff` and `complete` are whole-surface takeovers, and only `active` means "hand
 * the slots to a layout".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { useHorizontalSwipe } from '@/lib/hooks/use-horizontal-swipe';
import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { useFormAnswers } from '@/lib/hooks/use-form-answers';
import { useSessionLifecycle } from '@/lib/hooks/use-session-lifecycle';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { useStitchedHistory } from '@/lib/hooks/use-stitched-history';
import {
  diffNewlyFilled,
  diffNewlyFilledQuestions,
} from '@/lib/app/questionnaire/panel/newly-filled';
import { buildCorrectionTargets } from '@/lib/app/questionnaire/panel/correction-targets';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import {
  CHAT_TEXT_AUTHORED_STORAGE_KEY,
  CHAT_TEXT_SCALE_STORAGE_KEY,
  DEFAULT_CHAT_TEXT_SCALE_INDEX,
  normalizeScaleIndex,
  scaleForIndex,
} from '@/lib/app/questionnaire/chat/text-scale';
import { API } from '@/lib/api/endpoints';
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
import type { AnswerSlotPanelScope, PresentationMode } from '@/lib/app/questionnaire/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';

/**
 * Which surface the carousel is showing. `intro`, `capture`, and `persona` are pre-chat "gates" that
 * only exist when their feature is on; all defer the opening LLM turn until the respondent moves past
 * them. `capture` is additionally BLOCKING — unlike intro/persona (which the respondent may swipe past
 * freely), the respondent cannot advance beyond it until the profile form is submitted and validated.
 */
export type WorkspaceView = 'intro' | 'capture' | 'persona' | 'chat' | 'form';

/**
 * Which whole-surface state the session is in.
 *
 * Only `active` hands off to a layout. The other three replace the surface entirely, and they are
 * checked in this order because they overlap: a read-only admin replay of a completed session
 * shows the transcript, not the respondent's completion screen; and a completed leg of an
 * Experience is not the end of anything until the run selector says so.
 */
export type WorkspacePhase = 'readOnly' | 'handoff' | 'complete' | 'active';

export interface UseSessionWorkspaceOptions {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  initialTurns?: QuestionnaireTurn[];
  initialInspectorTurns?: TurnInspectorData[];
  initialStatus?: QuestionnaireChatStatus;
  initialPanel?: AnswerPanelView;
  initialStatusView?: SessionStatusView;
  initialFormView?: AnswerPanelView;
  autoStart?: boolean;
  presentationMode?: PresentationMode;
  answerPanelScope?: AnswerSlotPanelScope;
  /**
   * Does the chosen layout put the answer panel back on screen at `lg`?
   *
   * Read from `placements.answersPanel.kind` by the container, which already reads it to decide
   * whether to build the panel node and whether the review trigger carries `lg:hidden` — the same
   * one declaration driving every consequence, rather than three places guessing. Only the
   * review-sheet auto-close below depends on it here. Defaults to `true`, which is Classic.
   */
  panelReturnsAtLg?: boolean;
  /**
   * The ladder rung the conversation OPENS at (`config.chatTextSize`, resolved server-side to an
   * index). An explicitly authored rung — anything other than the standard one — is adopted on
   * arrival even by a respondent who has stepped before, once per authored value; see the storage
   * note below for why that is not the same as overriding their preference. Defaults to the
   * standard rung, which is what every session opened at before the setting existed.
   */
  chatTextScaleIndex?: number;
  inlineCorrectionEnabled?: boolean;
  readOnly?: boolean;
  intro?: ResolvedSessionIntro | null;
  personas?: ResolvedSessionPersonas | null;
  capture?: ResolvedSessionCapture | null;
}

export interface SessionWorkspaceState {
  /** Branch on this before anything else — see {@link WorkspacePhase}. */
  phase: WorkspacePhase;

  /* Surfaces + carousel */
  views: WorkspaceView[];
  activeView: WorkspaceView;
  activeIndex: number;
  multiView: boolean;
  goToView: (view: WorkspaceView) => void;
  goRelative: (delta: number) => void;
  carouselRef: React.RefObject<HTMLDivElement | null>;
  swipe: ReturnType<typeof useHorizontalSwipe>;

  /* Feature gates */
  showChat: boolean;
  showForm: boolean;
  showPanel: boolean;
  showIntro: boolean;
  showCapture: boolean;
  showPersona: boolean;
  showInterviewerChip: boolean;
  captureBlocking: boolean;

  /* Composed data hooks */
  stream: ReturnType<typeof useQuestionnaireSessionStream>;
  panel: ReturnType<typeof useAnswerPanel>;
  lifecycle: ReturnType<typeof useSessionLifecycle>;
  form: ReturnType<typeof useFormAnswers>;

  /* Derived view data */
  turnCount: number;
  formBlocked: boolean;
  correction: { sessionId: string; accessToken?: string; onCorrected: () => void } | undefined;
  correctionTargets: CorrectionTarget[];
  newlyFilledKeys: readonly string[];
  reviewCountLabel: string | null;
  answeredCount: number;

  /* Text size */
  textScaleIndex: number;
  setTextScaleIndex: (index: number) => void;
  chatScaleStyle: CSSProperties;

  /* Completion */
  heldProbe: { text: string; early: boolean } | null;
  finalCheckOpen: boolean;
  closeFinalCheck: () => void;
  doSubmit: () => void;
  doFinishEarly: () => void;
  finishAnyway: () => void;

  /* Review sheet */
  reviewOpen: boolean;
  setReviewOpen: (open: boolean) => void;

  /* Persona */
  selectedPersonaKey: string | null;
  currentPersonaLabel: string;
  choosePersona: (key: string) => void;
  onChangeInterviewer: () => void;
  personaModalOpen: boolean;
  setPersonaModalOpen: (open: boolean) => void;

  /* Panel actions */
  handleRevisit: (slot: PanelSlotView) => void;
  handleRefine: (slot: DataSlotPanelSlot) => void;
  handleCaptureSubmitted: () => void;
  onTurnSettled: () => void;

  /* Experiences */
  experience: NonNullable<SessionStatusView['experience']> | null;
  stitched: boolean;
  stitchedHistory: ReturnType<typeof useStitchedHistory>;
  stitchedSeamLabel: string | null | undefined;
  setStitchedOutcome: (outcome: RunPollState | null) => void;
  onContinue: (nextSessionId: string) => void;
  onConclude: () => void;
}

export function useSessionWorkspace({
  sessionId,
  accessToken,
  initialTurns,
  initialInspectorTurns,
  initialStatus,
  initialPanel,
  initialStatusView,
  initialFormView,
  autoStart = false,
  panelReturnsAtLg = true,
  chatTextScaleIndex = DEFAULT_CHAT_TEXT_SCALE_INDEX,
  presentationMode = 'both',
  answerPanelScope = 'full_progress',
  inlineCorrectionEnabled = false,
  readOnly = false,
  intro = null,
  personas = null,
  capture = null,
}: UseSessionWorkspaceOptions): SessionWorkspaceState {
  const showChat = presentationMode === 'chat' || presentationMode === 'both';
  const showForm = presentationMode === 'form' || presentationMode === 'both';
  // Chat-only (`answerSlotPanelScope: 'hidden'`): the conversation is the whole surface — no side
  // panel on `lg`+, no mobile review sheet, no "Review answers" trigger. Orthogonal to
  // `presentationMode`: a hidden panel still allows the form tab, which is its own surface.
  const showPanel = answerPanelScope !== 'hidden';
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
  // Respondent-owned chat text size, persisted globally rather than per session: someone who needs
  // larger text needs it in the next leg of an Experience too, and should not re-set it each time.
  // `useLocalStorage` hydrates after mount (SSR-safe), so the first paint is the authored opening
  // size and settles to the stored one — a font-size change only, no layout shift beyond reflow.
  const [storedTextScaleIndex, setTextScaleIndex] = useLocalStorage<number>(
    CHAT_TEXT_SCALE_STORAGE_KEY,
    normalizeScaleIndex(chatTextScaleIndex)
  );
  // Adopt the questionnaire's authored rung.
  //
  // Passing it as `useLocalStorage`'s `initial` is NOT enough on its own: `initial` applies only
  // while nothing is stored, so the setting was inert for anyone who had ever touched the stepper
  // — including the author previewing their own choice, who is the person most likely to have
  // touched it. A setting whose author cannot see it working is not a setting.
  //
  // So an EXPLICIT authored rung (anything but the standard one — the column's default, which is
  // indistinguishable from "never set") is adopted here, once per authored value. The marker key
  // records what was last adopted: it differs → move to the authored rung and record it; it
  // matches → leave the respondent's rung alone, which is what makes a step away from the authored
  // size survive a reload. An author can therefore say how the conversation opens and change their
  // mind, but cannot pin, cap, or repeatedly reset anyone's size, and the stepper never goes away.
  //
  // Runs after `useLocalStorage`'s own mount hydration (declared above, so its effect is queued
  // first) — otherwise the stored rung would land last and win. Guarded by a ref rather than
  // effect deps because it must fire once per mount, not once per render that changes the prop.
  const authoredAdoptedRef = useRef(false);
  useEffect(() => {
    if (authoredAdoptedRef.current) return;
    authoredAdoptedRef.current = true;
    const authored = normalizeScaleIndex(chatTextScaleIndex);
    if (authored === DEFAULT_CHAT_TEXT_SCALE_INDEX) return;
    let alreadyAdopted: unknown = null;
    try {
      const raw = window.localStorage.getItem(CHAT_TEXT_AUTHORED_STORAGE_KEY);
      alreadyAdopted = raw === null ? null : JSON.parse(raw);
    } catch {
      // Unreadable or malformed marker reads as "nothing adopted yet" — re-adopting the authored
      // rung is the recoverable outcome; refusing to would strand the setting.
      alreadyAdopted = null;
    }
    if (alreadyAdopted === authored) return;
    try {
      window.localStorage.setItem(CHAT_TEXT_AUTHORED_STORAGE_KEY, JSON.stringify(authored));
    } catch {
      // Private-mode / quota: adopt the rung for this visit anyway. The cost of not writing the
      // marker is that the next visit adopts again, not that the respondent loses their size now.
    }
    setTextScaleIndex(authored);
  }, [chatTextScaleIndex, setTextScaleIndex]);
  // Storage is untrusted (stale ladder, another tab, hand-edited); normalise before it can reach a
  // `calc()`, where a NaN would silently drop the transcript's font-size entirely.
  const textScaleIndex = normalizeScaleIndex(storedTextScaleIndex);
  // CSS custom properties aren't part of `CSSProperties`, so the var is declared on its own typed
  // const rather than asserted inline.
  const chatScaleStyle: CSSProperties & Record<'--cq-chat-scale', string> = {
    '--cq-chat-scale': String(scaleForIndex(textScaleIndex)),
  };
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

  // The review sheet is the NARROW-viewport twin of the side panel, so when the panel comes back at
  // `lg` the sheet should get out of its way — the trigger is `lg:hidden` there, and a sheet
  // lingering over a visible panel is two copies of the same thing.
  //
  // But that is only true of a layout that HAS a panel at `lg`. Focus, Broadsheet and Horizon all
  // omit `answersPanel` and keep the review affordance at every width — the sheet becomes a side
  // drawer rather than retiring. Closing it there would take away the only route to the captured
  // answers: a respondent on a tablet opens their answers in portrait, rotates to landscape, and
  // watches them vanish mid-read. Hence the gate, keyed on the same placement reading the trigger
  // and the drawer already share.
  useEffect(() => {
    if (!panelReturnsAtLg) return;
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const close = () => {
      if (mq.matches) setReviewOpen(false);
    };
    close();
    mq.addEventListener('change', close);
    return () => mq.removeEventListener('change', close);
  }, [panelReturnsAtLg]);

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

  /* ---------------------------------------------------------------------- */
  /* Derived render inputs                                                   */
  /* ---------------------------------------------------------------------- */

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

  // Answers recorded so far — drives the "Begin" ⇄ "Continue" CTA label on the intro and persona
  // gates. A merely-opened session still reads "Begin".
  const answeredCount = lifecycle.view?.completion.answeredCount ?? 0;

  // Completion affordance, by precedence: the agent's full submit offer wins (the session is
  // genuinely "done enough"); otherwise the respondent-controlled early-finish escape hatch shows
  // once unlocked. Shared verbatim by the chat and form surfaces.
  // While a final-check probe is held, re-clicking submit/finish is the "finish anyway" escape (skip
  // the sweep) rather than a re-sweep that would just hold again on the same still-unresolved conflict.
  const doSubmit = useCallback(() => {
    void (heldProbe ? lifecycle.finishAnyway(heldProbe.early) : lifecycle.submit());
  }, [heldProbe, lifecycle]);
  const doFinishEarly = useCallback(() => {
    void (heldProbe ? lifecycle.finishAnyway(heldProbe.early) : lifecycle.finishEarly());
  }, [heldProbe, lifecycle]);
  const finishAnyway = useCallback(() => {
    void lifecycle.finishAnyway(heldProbe?.early ?? true);
  }, [heldProbe, lifecycle]);
  // Just close the modal — leave `heldProbe` (incl. `early`) intact so the still-visible finish
  // affordance keeps working as "finish anyway" with the correct early flag.
  const closeFinalCheck = useCallback(() => setFinalCheckOpen(false), []);

  /* ---------------------------------------------------------------------- */
  /* Phase                                                                   */
  /* ---------------------------------------------------------------------- */

  // Submitted → the conversation/form is done; the caller shows a confirmation in place of the
  // workspace. Either the in-session submit flipped the stream to `completed`, OR the session was
  // already completed when this surface loaded (a resume / reopen) — the lifecycle status read is
  // the authority for the latter. Without that second arm a reopened completed session would drop
  // into the chat and, on any further send, hit the "session no longer active" panel.
  const completed = stream.status === 'completed' || lifecycle.view?.status === 'completed';
  // A leg of an experience is NOT the end of anything yet — the selector may still route the
  // respondent onward. `stitchedOutcome` is how the stitched branch falls through: once the fork
  // resolves to an ending (or the handoff fails) there is nothing left to continue into, and the
  // ordinary completion screen — with its report and download — is the right destination.
  const phase: WorkspacePhase = readOnly
    ? 'readOnly'
    : !completed
      ? 'active'
      : experience && canHandOff && !stitchedOutcome
        ? 'handoff'
        : 'complete';

  return {
    phase,

    views,
    activeView,
    activeIndex,
    multiView,
    goToView,
    goRelative,
    carouselRef,
    swipe,

    showChat,
    showForm,
    showPanel,
    showIntro,
    showCapture,
    showPersona,
    showInterviewerChip,
    captureBlocking,

    stream,
    panel,
    lifecycle,
    form,

    turnCount,
    formBlocked,
    correction,
    correctionTargets,
    newlyFilledKeys,
    reviewCountLabel,
    answeredCount,

    textScaleIndex,
    setTextScaleIndex,
    chatScaleStyle,

    heldProbe,
    finalCheckOpen,
    closeFinalCheck,
    doSubmit,
    doFinishEarly,
    finishAnyway,

    reviewOpen,
    setReviewOpen,

    selectedPersonaKey,
    currentPersonaLabel,
    choosePersona,
    onChangeInterviewer,
    personaModalOpen,
    setPersonaModalOpen,

    handleRevisit,
    handleRefine,
    handleCaptureSubmitted,
    onTurnSettled,

    experience,
    stitched,
    stitchedHistory,
    stitchedSeamLabel,
    setStitchedOutcome,
    onContinue,
    onConclude,
  };
}
