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
import { BookOpen, ClipboardList, ListChecks, MessageSquare } from 'lucide-react';

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
import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';
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

/** Which surface the carousel is showing. `intro` only exists on a fresh, intro-enabled session. */
type WorkspaceView = 'intro' | 'chat' | 'form';

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
   * `undefined`/null when the feature is off (platform flag or version toggle off). The page
   * resolves the gate server-side and passes the effective placement; the chat renders nothing
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
}

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
}: SessionWorkspaceProps) {
  const showChat = presentationMode === 'chat' || presentationMode === 'both';
  const showForm = presentationMode === 'form' || presentationMode === 'both';
  // The intro recap rides the carousel whenever the version enables it — on a fresh session AND on a
  // resume, so a returning respondent can still slide back to re-read it. (`autoStart` only governs
  // whether we LAND on it and defer the kickoff; see below.) Never in the read-only admin viewer.
  const showIntro = Boolean(intro?.enabled && !readOnly);
  // A fresh, intro-enabled session opens ON the intro and holds the opening turn until the
  // respondent leaves it. A resume drops straight into the conversation with the intro a tap away.
  const openOnIntro = showIntro && autoStart;

  // The carousel surfaces, left→right, present-only. At least one of chat/form always exists
  // (presentationMode is chat | form | both), so this is never empty.
  const views = useMemo<WorkspaceView[]>(() => {
    const list: WorkspaceView[] = [];
    if (showIntro) list.push('intro');
    if (showChat) list.push('chat');
    if (showForm) list.push('form');
    return list;
  }, [showIntro, showChat, showForm]);

  // Active surface. A fresh intro session opens on the intro; everything else opens on the primary
  // surface (a resume keeps the intro reachable via the toggle, but lands on the conversation).
  const [activeView, setActiveView] = useState<WorkspaceView>(
    openOnIntro ? 'intro' : presentationMode === 'form' ? 'form' : 'chat'
  );
  // Has the respondent left the intro at least once? Gates the LLM kickoff so no turn is spent while
  // they're still reading. Initialises `true` whenever we don't open on the intro (resume, or no
  // intro at all), preserving the "open immediately" behaviour for every non-fresh-intro path.
  const [started, setStarted] = useState(!openOnIntro);
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
  // Both reads refetch on each clean turn-settle. The stream reads its `onTurnSettled`
  // through a ref, so routing the refetches through refs here breaks the declaration
  // cycle (stream needs the settle handler; the hooks below need the stream's applyStatus).
  const panelRefetchRef = useRef<(() => void) | null>(null);
  const lifecycleRefetchRef = useRef<(() => void) | null>(null);

  const onTurnSettled = useCallback(() => {
    panelRefetchRef.current?.();
    lifecycleRefetchRef.current?.();
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

  const lifecycle = useSessionLifecycle({
    sessionId,
    accessToken,
    initialView: initialStatusView,
    applyStatus: stream.applyStatus,
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
    if (!showChat) return; // form-only mode never opens a chat turn
    if (streamStatus !== 'idle') return;
    if (turnCount > 1) return;
    void kickoff();
  }, [autoStart, started, showChat, kickoff, streamStatus, turnCount]);

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

  // Carousel navigation. Leaving the intro (to either surface) marks the session started, which
  // releases the deferred kickoff. Switching TO the form re-seeds it so chat-inferred answers appear;
  // switching TO chat refetches the panel so it reflects the form's edits.
  const goToView = useCallback(
    (view: WorkspaceView) => {
      setActiveView(view);
      if (view !== 'intro') setStarted(true);
      if (view === 'form') form.refresh();
      else if (view === 'chat') panel.refetch();
    },
    [form, panel]
  );

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
    return (
      <SessionComplete
        sessionId={sessionId}
        accessToken={accessToken}
        answeredCount={lifecycle.view?.completion.answeredCount ?? null}
        refRaw={lifecycle.view?.ref ?? null}
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
  const VIEW_META: Record<WorkspaceView, { label: string; Icon: typeof BookOpen }> = {
    intro: { label: 'Intro', Icon: BookOpen },
    chat: { label: 'Chat', Icon: MessageSquare },
    form: { label: 'Form', Icon: ListChecks },
  };
  const toggleItems: ToggleItem[] = views.map((id) => ({ id, ...VIEW_META[id] }));
  const showToggle = views.length > 1;

  // Right-cluster controls: the surface toggle and the mobile answer-review trigger. Kept
  // `undefined` when neither applies so the lifecycle strip still collapses to nothing on a plain
  // form-only session (the bar renders the strip whenever `trailing` is present).
  const showReviewTrigger = showChat && activeView !== 'intro'; // the answer panel only rides the chat surface
  const trailingControls =
    showToggle || showReviewTrigger ? (
      <>
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
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
            Review answers
            {/* The count is redundant with the top progress bar's percent; show it only where
                there's room (≥sm), so phones get a compact icon + label that won't squash. */}
            {reviewCountLabel && (
              <span className="text-muted-foreground ml-1.5 hidden sm:inline">
                · {reviewCountLabel}
              </span>
            )}
          </Button>
        )}
      </>
    ) : undefined;

  const chatSurface = (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]">
      <div className="flex min-h-0 flex-col gap-3">
        {lifecycle.canSubmit && (
          <CompletionOffer onSubmit={() => void lifecycle.submit()} busy={lifecycle.busy} />
        )}
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
      {lifecycle.canSubmit && (
        <CompletionOffer onSubmit={() => void lifecycle.submit()} busy={lifecycle.busy} />
      )}
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
        onProceed={() => goToView(views.find((v) => v !== 'intro') ?? 'chat')}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
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
        <div className="relative min-h-0 flex-1 overflow-clip">
          {views.map((view) => {
            const activeIndex = Math.max(0, views.indexOf(activeView));
            const offset = (views.indexOf(view) - activeIndex) * 100;
            return (
              <div
                key={view}
                role="tabpanel"
                aria-label={VIEW_META[view].label}
                className="absolute inset-0 overflow-clip transition-transform duration-300 ease-out motion-reduce:transition-none"
                style={{ transform: `translateX(${offset}%)` }}
                inert={activeView !== view}
              >
                {view === 'intro' ? introSurface : view === 'form' ? formSurface : chatSurface}
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
