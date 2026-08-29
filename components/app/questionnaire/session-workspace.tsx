'use client';

/**
 * SessionWorkspace — the respondent surface's container.
 *
 * Three jobs, and deliberately no fourth:
 *   1. Run {@link useSessionWorkspace}, which owns every hook, every gate and every piece of
 *      session state. Nothing about behaviour is decided here.
 *   2. Handle the whole-surface takeovers — the read-only admin replay, an Experience handoff,
 *      and the completion screen — which replace the workspace rather than sitting inside it.
 *   3. Build each part as a ready-to-render node and hand the set to the questionnaire's chosen
 *      layout, which decides where things go and nothing else. That includes mounting the one
 *      provider two of those parts share: `transcript` and `composer` may be placed with nothing
 *      between them, so the clock that keeps the composer shut until a reply has finished revealing
 *      rides above the whole layout — for the same reason `--cq-chat-scale` is set here.
 *
 * This used to be one 1200-line component that did all of that plus the arrangement. Splitting it
 * is what makes a second layout possible without re-deriving the gates — and the gates are subtle
 * enough (a blocking capture form defers the opening LLM turn; releasing it a step early streams a
 * question behind the persona picker in the wrong voice) that a second derivation would drift.
 *
 * The commercial promise this structure protects: **whichever layout is chosen, every feature is
 * still reachable.** `lib/app/questionnaire/layout/slots.ts` turns that into a compile error rather
 * than a hope — see it, and `.context/app/questionnaire/respondent-layouts.md`, for the mechanism.
 */

import type { ReactNode } from 'react';
import { ClipboardList } from 'lucide-react';

import { cn } from '@/lib/utils';

import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { ChatHistory } from '@/components/app/questionnaire/chat/chat-history';
import { CurrentExchange } from '@/components/app/questionnaire/chat/current-exchange';
import { ReleaseStageNotice } from '@/components/app/questionnaire/chat/release-stage-notice';
import { ChatComposer } from '@/components/app/questionnaire/chat/chat-composer';
import { ConversationProvider } from '@/components/app/questionnaire/chat/conversation-context';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import { AnswerReviewDrawer } from '@/components/app/questionnaire/panel/answer-review-drawer';
import { Button } from '@/components/ui/button';
import { QuestionnaireForm } from '@/components/app/questionnaire/form/questionnaire-form';
import { ModeToggle, type ToggleItem } from '@/components/app/questionnaire/mode-toggle';
import { ChatTextSize } from '@/components/app/questionnaire/chat/chat-text-size';
import { QuestionnaireSplash } from '@/components/app/questionnaire/intro/questionnaire-splash';
import { PersonaPicker } from '@/components/app/questionnaire/persona/persona-picker';
import {
  CurrentInterviewerChip,
  PersonaSwitcherModal,
} from '@/components/app/questionnaire/persona/interviewer-switcher';
import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import { SessionProgressBar } from '@/components/app/questionnaire/session-progress-bar';
import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';
import { EarlyFinishControl } from '@/components/app/questionnaire/lifecycle/early-finish-control';
import { FinalCheckModal } from '@/components/app/questionnaire/lifecycle/final-check-modal';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';
import { TranscriptDownload } from '@/components/app/questionnaire/lifecycle/transcript-download';
import { ProfileCaptureGate } from '@/components/app/questionnaire/profile/profile-capture-gate';
import { HandoffCard } from '@/components/app/questionnaire/experiences/handoff-card';
import { StitchedContinuation } from '@/components/app/questionnaire/experiences/stitched-continuation';
import { VIEW_META } from '@/components/app/questionnaire/layouts/view-meta';
import { resolveLayout } from '@/components/app/questionnaire/layouts/registry';
import type { RespondentSlots } from '@/components/app/questionnaire/layouts/types';
import { hasConversationHistory } from '@/lib/app/questionnaire/chat/exchange';
import { stepScaleIndex } from '@/lib/app/questionnaire/chat/text-scale';
import { useSessionWorkspace, type WorkspaceView } from '@/lib/hooks/use-session-workspace';
import type { GlossaryAppendixView, GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import {
  isTerminalStatus,
  type QuestionnaireChatStatus,
  type QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type {
  AnswerSlotPanelScope,
  PresentationMode,
  ReasoningPlacement,
  RespondentLayout,
} from '@/lib/app/questionnaire/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';

export type { WorkspaceView };

export interface SessionWorkspaceProps {
  /**
   * Definitions / glossary (P16): the version's live terms, resolved server-side by the page and
   * already gated on `glossaryRespondentHints` (the page passes `[]` when it is off, so nothing
   * downstream carries a flag). Forwarded to the chat, where a matched term in the interviewer's
   * messages is underlined with its definition in a popover, and to the form's question labels.
   */
  glossary?: readonly GlossaryEntry[];
  /**
   * Definitions / glossary (P16): the appendix for the completion screen, gated by the SEPARATE
   * `glossaryReportAppendix` switch (an admin may want definitions live in the conversation but
   * not appended to the delivered report, or the reverse). Built server-side so the screen and
   * the downloadable PDF can never disagree about what the report contains.
   */
  glossaryAppendix?: GlossaryAppendixView | null;
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
  /** Show the "N% completed" text beside the progress bar (`config.showProgressPercentText`). The
   * bar itself always renders. Default `true`. */
  showProgressPercentText?: boolean;
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
   * (toggle). Drives which surfaces ride the carousel.
   */
  presentationMode?: PresentationMode;
  /**
   * How the respondent surface is ARRANGED (F-layouts). Orthogonal to `presentationMode`: that
   * decides *what* the respondent completes, this decides *where the parts sit*. Defaults to —
   * and falls back to — ConQuest Classic, so an absent or unrecognised value is always safe.
   */
  respondentLayout?: RespondentLayout;
  /**
   * The rung the conversation OPENS at (`config.chatTextSize`, already resolved to a ladder index
   * by the server). An explicitly authored rung — anything but the standard one — is adopted on
   * arrival even by a respondent who has stepped before, once per authored value; after that their
   * own rung stands until the author moves the setting again. See the adoption effect in
   * `useSessionWorkspace` for the full rule. Omitted (a client-booted surface with no config yet)
   * → the standard rung, which is what every session opened at before the setting existed.
   */
  chatTextScaleIndex?: number;
  /**
   * How much of the live answer panel the respondent sees (F7.2): `full_progress`, `answered_only`,
   * or `hidden` — the chat-only surface, where no panel rides beside the conversation, the mobile
   * "Review answers" sheet is gone, and the transcript takes the full shell width. Defaults to
   * `full_progress`. Passed as a prop rather than read off the fetched view's own `scope` so the
   * layout is correct on first paint instead of reflowing when the first fetch lands.
   */
  answerPanelScope?: AnswerSlotPanelScope;
  /** SSR-resolved full form view (forForm) for `form`/`both` modes; omit for anonymous. */
  initialFormView?: AnswerPanelView;
  /**
   * Live "watch it think" reasoning placement (demo feature) — `overlay` | `inline`, or
   * `undefined`/null when the version toggle is off. The page resolves the gate server-side
   * and passes the effective placement; the chat renders nothing when it's absent.
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
  /**
   * Cross-device resume affordance ("already started on another device? enter your code"), supplied
   * by the public page. It has no row of its own on purpose: it rides the intro splash's existing
   * footer, and — when the version disables the intro, so there is no such footer — the lifecycle
   * strip instead. Either way it costs zero vertical space and stays inside the surface, unlike a
   * strip below it (which overflows the page's fixed height budget onto the site footer).
   */
  resumeByRef?: ReactNode;
}

export function SessionWorkspace({
  glossary,
  glossaryAppendix,
  sessionId,
  accessToken,
  initialTurns,
  initialInspectorTurns,
  initialStatus,
  initialPanel,
  initialStatusView,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  showProgressPercentText = true,
  autoStart = false,
  presentationMode = 'both',
  respondentLayout,
  chatTextScaleIndex,
  answerPanelScope = 'full_progress',
  initialFormView,
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  inlineCorrectionEnabled = false,
  readOnly = false,
  intro = null,
  personas = null,
  capture = null,
  resumeByRef,
}: SessionWorkspaceProps) {
  // Resolved before the hook, not after, because the hook needs one of its declarations — and
  // hooks run before the whole-surface takeovers below can early-return. `resolveLayout` is pure
  // and total, so calling it here costs nothing and cannot fail.
  const { Component: Layout, placements } = resolveLayout(respondentLayout);
  // Does this layout put the answer panel back on screen at `lg`? One declaration, read once, and
  // handed to everything that depends on it: whether to build the panel node, whether the review
  // trigger carries `lg:hidden`, whether the review SHEET retires at `lg` — and now whether the
  // sheet auto-closes on a resize past `lg`, which was silently wrong for every panel-less layout.
  const panelInline = placements.answersPanel.kind === 'region';

  const state = useSessionWorkspace({
    sessionId,
    accessToken,
    initialTurns,
    initialInspectorTurns,
    initialStatus,
    initialPanel,
    initialStatusView,
    initialFormView,
    autoStart,
    presentationMode,
    answerPanelScope,
    inlineCorrectionEnabled,
    readOnly,
    intro,
    personas,
    capture,
    panelReturnsAtLg: panelInline,
    chatTextScaleIndex,
  });

  const {
    phase,
    stream,
    panel,
    lifecycle,
    form,
    views,
    activeView,
    showChat,
    showPanel,
    showIntro,
    showCapture,
    showPersona,
    showInterviewerChip,
    captureBlocking,
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
    goToView,
  } = state;

  /* ---------------------------------------------------------------------- */
  /* Whole-surface takeovers                                                 */
  /* ---------------------------------------------------------------------- */

  // Read-only viewer (admin): just the transcript, no chrome. A completed session is shown as its
  // conversation here, not the respondent's completion screen.
  if (phase === 'readOnly') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <QuestionnaireChat
          sessionId={sessionId}
          glossary={glossary}
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

  // A completed leg of an Experience is NOT the end of anything yet — the selector may still route
  // the respondent onward. Before P15.3 the completion screen was unconditional here, so a finished
  // leg dead-ended and the whole run machinery behind it was unreachable.
  if (phase === 'handoff' && experience) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        {stitched ? (
          <StitchedContinuation
            runId={experience.runId}
            sessionId={sessionId}
            sessionToken={accessToken}
            onContinue={onContinue}
            onSettled={setStitchedOutcome}
          />
        ) : (
          <HandoffCard
            runId={experience.runId}
            sessionId={sessionId}
            sessionToken={accessToken}
            onContinue={onContinue}
            onConclude={onConclude}
          />
        )}
      </div>
    );
  }

  if (phase === 'complete') {
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
        glossaryAppendix={glossaryAppendix ?? null}
        // A `form`-mode questionnaire never opens the chat surface, so it persists no turns and
        // has no transcript to offer. `showChat` (not `presentationMode` directly) because it is
        // the same derivation the strip's own transcript control reads — one rule, two surfaces.
        hasConversation={showChat}
        // Early-finish "Continue answering" (F-early-finish-reopen): server-gated via
        // `lifecycle.view.reopenAvailable`. `reopen()` flips `stream.status`/`lifecycle.view.status`
        // away from `completed`, so this component simply unmounts on success — `phase` falls back
        // to `active` on the next render.
        canReopen={lifecycle.canReopen}
        onReopen={lifecycle.reopen}
        reopenBusy={lifecycle.busy}
      />
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Slot construction                                                       */
  /* ---------------------------------------------------------------------- */

  // The text-size stepper rides with the chat surface only: on the form, intro and persona pages
  // there is no transcript for it to act on, and a control that appears to do nothing is worse than
  // one that is absent.
  const showTextSize = activeView === 'chat';
  // The interviewer chip only makes sense on the chat surface (not while reading the intro / on the
  // form / on the picker page itself).
  const showChipHere = showInterviewerChip && activeView === 'chat';
  // Suppressed entirely while the blocking capture gate is open — the toggle would otherwise offer a
  // one-tap skip past required details (and `ModeToggle` has no per-segment disabled state). The intro
  // Proceed button and the gate's own submit drive the flow until the details are in.
  const showToggle = views.length > 1 && !captureBlocking;
  // The chosen layout, resolved before the slots because its placement declaration is load-bearing
  // rather than decorative: two slots below are built differently depending on whether this layout
  // keeps the answer panel on screen. Reading the declaration (instead of re-deciding here) is what
  // stops the two drifting — a layout that changes its mind about the panel changes both at once.
  // Does this layout's composer region hand it the whole height of its column? Broadsheet's margin
  // does. Read here rather than styled in the layout because a layout places nodes it did not build
  // — it cannot reach inside the composer and tell the textarea to grow.
  const composerFills = placements.composer.kind === 'region' && placements.composer.fills === true;
  // And does that region want the composer PRESENT in the room it was given, or tucked into a
  // corner of it? Broadsheet's bare margin and Horizon's one-question stage both say present, and
  // get the bordered box at prose height with its controls inside; Classic and Focus say tucked,
  // because there a scrolling transcript is competing for the same viewport. Read here for the same
  // reason as `fills`: a layout places a node it did not build and cannot reach inside it.
  const composerProminent =
    placements.composer.kind === 'region' && placements.composer.prominent === true;

  const showReviewTrigger =
    showChat &&
    showPanel && // chat-only mode has no answers surface to review
    activeView !== 'intro' &&
    activeView !== 'capture' &&
    activeView !== 'persona'; // the answer panel only rides the chat surface

  const textSize = showTextSize ? (
    <ChatTextSize
      index={textScaleIndex}
      onStep={(direction) => setTextScaleIndex(stepScaleIndex(textScaleIndex, direction))}
    />
  ) : null;

  const interviewerChip = showChipHere ? (
    <CurrentInterviewerChip
      label={currentPersonaLabel}
      onChange={onChangeInterviewer}
      busy={stream.status === 'streaming'}
    />
  ) : null;

  // The carousel toggle's segments, derived from the present surfaces (left→right). Shown whenever
  // there's more than one surface to move between — chat↔form, or intro alongside either.
  const toggleItems: ToggleItem[] = views.map((id) => ({ id, ...VIEW_META[id] }));
  const modeToggle = showToggle ? (
    <ModeToggle
      value={activeView}
      items={toggleItems}
      onChange={(v) => goToView(v as WorkspaceView)}
    />
  ) : null;

  const reviewTrigger = showReviewTrigger ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // Pill shape echoes the ModeToggle so the two read as one control group when they share a
      // wrapped row on mobile. Hidden once the side panel returns (`lg`) — but ONLY where a panel
      // returns at all: in a layout that relocates review into the sheet, this is the sole route to
      // the captured answers and must stay at every width.
      // Below `sm` the clipboard glyph stands alone. It shares the control line with the surface
      // switcher, and the switcher's labels are the ones worth keeping: it is the row's subject and
      // its words are what tell the respondent where they are. Review is a single secondary action
      // with a distinctive icon and an `aria-label` that survives the collapse.
      className={cn('rounded-full max-sm:w-9 max-sm:px-0', panelInline && 'lg:hidden')}
      onClick={() => setReviewOpen(true)}
      aria-haspopup="dialog"
      aria-expanded={reviewOpen}
      aria-label={`Review answers${reviewCountLabel ? `, ${reviewCountLabel}` : ''}`}
    >
      <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {/* `aria-label` above keeps the control named when the word is hidden — and it is where the
          count now lives. The count used to be printed here too, and directly under a bar already
          reading "0% completed" it rendered as "Review answers · 0% complete": the same fact, in
          nearly the same words, twice in two rows, on the row that had the least width to spare. A
          screen-reader user has no bar to glance at, so it stays in the label; a sighted one does. */}
      <span className="max-sm:hidden">Review answers</span>
    </Button>
  ) : null;

  // Offer the transcript download once a real conversation exists (past the opening question) and
  // chat is in play — there's nothing to take away from an empty session.
  const transcriptDownload =
    showChat && turnCount > 1 ? (
      <TranscriptDownload
        sessionId={sessionId}
        accessToken={accessToken}
        variant="ghost"
        // On the strip it shares its line with the coverage bar and the reference chip, so below
        // `sm` it gives up its words and keeps the glyph.
        collapseLabel
      />
    ) : null;

  // Fallback home for the cross-device entry: with the intro disabled there is no splash footer to
  // carry it, and the strip is the only other row that costs it nothing.
  const resumeByRefOnStrip = showIntro ? undefined : resumeByRef;

  // The strip's two clusters. Both stay `undefined` when nothing applies, so the lifecycle bar still
  // collapses to nothing on a plain form-only session (it renders a line whenever either is present).
  //
  // The switcher leads and the tools trail, rather than everything piling into one right-aligned
  // cluster. It is the widest control on the strip and the one that says where you are, so it
  // anchors the left against the progress bar above; the tools — text size, the interviewer chip,
  // review — are secondary and sit together at the trailing edge. Cross-device resume joins the
  // switcher on the left, where it already lived.
  const leadingControls =
    modeToggle || resumeByRefOnStrip ? (
      <>
        {modeToggle}
        {resumeByRefOnStrip}
      </>
    ) : undefined;

  const trailingControls =
    textSize || interviewerChip || reviewTrigger ? (
      <>
        {textSize}
        {interviewerChip}
        {reviewTrigger}
      </>
    ) : undefined;

  // Completion affordance, by precedence: the agent's full submit offer wins (the session is
  // genuinely "done enough"); otherwise the respondent-controlled early-finish escape hatch shows
  // once unlocked. Shared verbatim by the chat and form surfaces.
  const completionOffer = lifecycle.canSubmit ? (
    <CompletionOffer onSubmit={doSubmit} busy={lifecycle.busy} />
  ) : lifecycle.canFinishEarly ? (
    <EarlyFinishControl onFinish={doFinishEarly} busy={lifecycle.busy} />
  ) : null;

  const slots: RespondentSlots = {
    // Rendered by the page's `BrandThemeProvider`, above this component — a slot key because a
    // layout still has to declare that it accepts a band it does not draw itself.
    brandBand: null,

    lifecycleBar: (
      // The chat ↔ form toggle rides the lifecycle strip (no dedicated row) and is always
      // visible in "both" mode, so the form escape-hatch reads as ever-present.
      <SessionLifecycleBar
        view={lifecycle.view}
        showProgressPercentText={showProgressPercentText}
        paused={stream.status === 'not_active'}
        busy={lifecycle.busy}
        actionError={lifecycle.actionError}
        canPause={lifecycle.canPause}
        canResume={lifecycle.canResume}
        onPause={() => void lifecycle.pause()}
        onResume={() => void lifecycle.resume()}
        download={transcriptDownload ?? undefined}
        trailing={trailingControls}
        leading={leadingControls}
      />
    ),
    // The bar draws its own progress. This standalone atom is for layouts that decompose the strip
    // and put coverage somewhere else entirely; Classic never places it.
    progress: lifecycle.view ? (
      // F17.33: `progressPct` (a whole percent, already held at the highest figure this session has
      // shown), not the raw `displayCoverage` — Conditional Topics can widen the interview mid-run
      // and the bar must never walk backwards. Divided back to the component's [0, 1] contract; it
      // rounds to the same integer.
      <SessionProgressBar
        coverage={lifecycle.view.completion.progressPct / 100}
        showPercentText={showProgressPercentText}
      />
    ) : null,
    sessionRef: resumeByRef ?? null,
    transcriptDownload,
    modeToggle,
    textSize,
    reviewTrigger,
    interviewerChip,

    // The intro recap as a carousel surface. Proceeding slides to the first real surface (chat, or
    // form in a form-only session), which marks the session started and releases the kickoff.
    splash:
      showIntro && intro ? (
        <QuestionnaireSplash
          intro={intro}
          // "Continue" only once a real answer exists — a merely-opened/resumed session at 0% still
          // reads "Begin" (the workspace's `started` flag governs the kickoff, not this label).
          inProgress={answeredCount > 0}
          // The intro CTA leads to whatever rides next, not always straight into the conversation: the
          // capture form ("Continue" to enter details), else the interviewer picker ("Select your
          // interviewer"). The configured begin label then lands on that surface's own CTA.
          proceedLabel={
            showCapture ? 'Continue' : showPersona ? 'Select your interviewer' : undefined
          }
          onProceed={() => goToView(views.find((v) => v !== 'intro') ?? 'chat')}
          footerAside={resumeByRef}
        />
      ) : null,

    // The profile capture form gate. Submitting validates + persists server-side, then advances to the
    // next surface (persona/chat) via `handleCaptureSubmitted`, which also releases the deferred kickoff.
    captureGate:
      showCapture && capture ? (
        <ProfileCaptureGate
          sessionId={sessionId}
          accessToken={accessToken}
          fields={capture.formFields}
          // When a persona picker follows, the CTA leads to it; otherwise it begins the conversation.
          proceedLabel={showPersona ? 'Continue' : (intro?.copy.buttonLabel ?? undefined)}
          onSubmitted={handleCaptureSubmitted}
        />
      ) : null,

    // The "Choose your interviewer" surface. Picking persists the choice; Continue slides to the chat
    // (which releases the deferred kickoff, now with the chosen persona already in place server-side).
    // As the last gate before the conversation, its CTA carries the configured begin label ("Begin your
    // conversation") — or "Continue" once the session already has an answer — right-aligned so it reads
    // as the final step of the pre-chat flow.
    personaPicker:
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
            answeredCount > 0 ? 'Continue' : (intro?.copy.buttonLabel ?? 'Begin your conversation')
          }
          alignEnd
        />
      ) : null,

    // The conversation, as independently-placeable parts. Stacking them back into one reading
    // column inside one card is the common case and belongs to `TranscriptColumn` and
    // `ConversationFrame` — the splits exist for Broadsheet (composer in the margin) and Horizon
    // (history folded behind a gesture), not so that every layout must re-arrange them. Their shared
    // timing — the reveal queue, the `composerReady` gate it feeds, and the boundary between the
    // history and the live exchange — travels through the `ConversationProvider` mounted above the
    // layout below, since the parts may have no closer common ancestor.

    // A slot of its own since Horizon, which folds the history away: a recording notice folded away
    // with it would not be a notice. `null` in the read-only admin replay — the admin is not the
    // recorded party — and the component itself renders nothing once the product is `stable`.
    releaseNotice: readOnly ? null : <ReleaseStageNotice />,

    // `null` when there is nothing behind the current exchange — a fresh session's opening burst is
    // all current exchange, and a stitched run's earlier legs count as history even before this leg
    // has a turn of its own. A real absence, because a layout that puts this behind a gesture
    // (Horizon) must not offer the gesture when it would open onto nothing.
    history: hasConversationHistory(stream.turns, stitchedHistory?.segments.length ?? 0) ? (
      <ChatHistory
        stream={stream}
        glossary={glossary}
        reasoningPlacement={reasoningPlacement}
        stitchedHistory={stitchedHistory}
        stitchedSeamLabel={stitchedSeamLabel}
      />
    ) : null,

    currentExchange: (
      <CurrentExchange
        sessionId={sessionId}
        glossary={glossary}
        accessToken={accessToken}
        stream={stream}
        reasoningPlacement={reasoningPlacement}
        reasoningDwellMs={reasoningDwellMs}
        reasoningPerItemMs={reasoningPerItemMs}
        correctionTargets={correctionTargets}
        onCorrected={onTurnSettled}
      />
    ),

    // `null` once no further input is possible (capped, paused, submitted, expired) — a real
    // absence rather than a hidden node, so a layout's frame draws no seam above nothing and a
    // margin-placed composer leaves no empty rail.
    composer: isTerminalStatus(stream.status) ? null : (
      <ChatComposer
        sessionId={sessionId}
        accessToken={accessToken}
        stream={stream}
        voiceInputEnabled={voiceInputEnabled}
        attachmentInputEnabled={attachmentInputEnabled}
        fillHeight={composerFills}
        prominent={composerProminent}
      />
    ),

    formView: (
      <QuestionnaireForm
        glossary={glossary}
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
    ),

    // `hidden lg:flex` is a property of the PAIR, not of one layout: the panel is the wide-viewport
    // affordance and `answersDrawer` is its narrow-viewport twin. A layout that relocates review
    // into the sheet declares `answersPanel` omitted, and gets `null` here rather than a node it
    // would have to hide.
    answersPanel:
      showPanel && panelInline ? (
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
      ) : null,

    // The answers sheet. In Classic it is the below-`lg` twin of the side panel; in a layout that
    // relocates review into the sheet it is the only route to the answers at any width. Same
    // `panelInline` reading as the trigger above, so the two cannot disagree about which it is —
    // they did once, and the result was a trigger that dimmed the screen and revealed nothing.
    // Chat-only mode (`answerSlotPanelScope: 'hidden'`) drops panel, sheet and trigger alike.
    answersDrawer: showPanel ? (
      <AnswerReviewDrawer
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        panelReturnsAtLg={panelInline}
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
    ) : null,

    completionOffer,

    // Final completion sweep (F7.3): the early-finish path surfaces the held probe in a modal over
    // the exit action. The normal (mid-conversation) path shows it in the chat instead (no modal),
    // so this only opens when the held submit was an early finish. Either way the probe is also a
    // chat turn; "Clarify in chat" closes the modal so they answer there.
    finalCheck: (
      <FinalCheckModal
        open={finalCheckOpen}
        probeText={heldProbe?.text ?? ''}
        onClarify={closeFinalCheck}
        onFinishAnyway={finishAnyway}
        busy={lifecycle.busy}
      />
    ),

    // Container-rendered takeovers — never on screen while a layout is.
    complete: null,
    handoff: null,

    // Interviewer switcher modal — the `indicator` switcher's "Change" opens this (there's no
    // carousel persona page in that mode). `both` uses the carousel page instead, so this stays
    // shut there. Picking persists immediately (fail-soft) and applies from the next turn.
    personaSwitcher:
      personas && showInterviewerChip && personas.switcher === 'indicator' ? (
        <PersonaSwitcherModal
          open={personaModalOpen}
          onOpenChange={setPersonaModalOpen}
          personas={personas.personas}
          selectedKey={selectedPersonaKey}
          defaultKey={personas.defaultPersonaKey}
          onChoose={choosePersona}
          busy={stream.status === 'streaming'}
        />
      ) : null,
  };

  return (
    // `--cq-chat-scale` is consumed by the `.cq-chat-scale` utility on the transcript (globals.css).
    // Set here, on the common ancestor of every layout's chrome and its conversation, so one property
    // drives the transcript while the strip's own `text-xs` chrome stays fixed — and so no layout has
    // to remember to carry it. `display: contents` means this wrapper generates no box of its own:
    // custom properties still inherit through it, but it cannot affect any layout's geometry.
    <div
      style={{ display: 'contents', ...chatScaleStyle }}
      // Stable hook for the text-scale tests. Without it they have to climb the tree for the
      // nearest styled ancestor, which silently retargets the moment any styled wrapper is added.
      data-testid="workspace-scale-root"
    >
      {/* The transcript and the composer are separate slots, and a layout may place them with no
          common ancestor between them (Broadsheet's composer lives in the margin). The clock they
          share — the reveal queue, and the `composerReady` gate it feeds — therefore rides a
          provider mounted here, above every layout, for the same reason `--cq-chat-scale` does: so
          no layout has to remember it, and so the composer can never open mid-reveal. */}
      <ConversationProvider stream={stream} animateOpening={autoStart}>
        <Layout slots={slots} state={state} />
      </ConversationProvider>
    </div>
  );
}
