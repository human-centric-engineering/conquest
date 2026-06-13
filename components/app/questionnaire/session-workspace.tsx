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

import { useCallback, useEffect, useRef, useState } from 'react';

import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { useFormAnswers } from '@/lib/hooks/use-form-answers';
import { useSessionLifecycle } from '@/lib/hooks/use-session-lifecycle';
import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import { QuestionnaireForm } from '@/components/app/questionnaire/form/questionnaire-form';
import { ModeToggle } from '@/components/app/questionnaire/mode-toggle';
import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';
import type {
  QuestionnaireChatStatus,
  QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';
import type { PresentationMode } from '@/lib/app/questionnaire/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

export interface SessionWorkspaceProps {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** Seed the transcript (e.g. a resume greeting). */
  initialTurns?: QuestionnaireTurn[];
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
}

export function SessionWorkspace({
  sessionId,
  accessToken,
  initialTurns,
  initialStatus,
  initialPanel,
  initialStatusView,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  autoStart = false,
  presentationMode = 'chat',
  initialFormView,
}: SessionWorkspaceProps) {
  const showChat = presentationMode === 'chat' || presentationMode === 'both';
  const showForm = presentationMode === 'form' || presentationMode === 'both';
  // "both" mode toggles between surfaces; single-mode pins the view.
  const [activeView, setActiveView] = useState<'chat' | 'form'>(
    presentationMode === 'form' ? 'form' : 'chat'
  );
  // Both reads refetch on each clean turn-settle. The stream reads its `onTurnSettled`
  // through a ref, so routing the refetches through refs here breaks the declaration
  // cycle (stream needs the settle handler; the hooks below need the stream's applyStatus).
  const panelRefetchRef = useRef<(() => void) | null>(null);
  const lifecycleRefetchRef = useRef<(() => void) | null>(null);

  const onTurnSettled = useCallback(() => {
    panelRefetchRef.current?.();
    lifecycleRefetchRef.current?.();
  }, []);

  const panel = useAnswerPanel({ sessionId, accessToken, initialView: initialPanel });

  const stream = useQuestionnaireSessionStream({
    sessionId,
    accessToken,
    initialTurns,
    initialStatus,
    onTurnSettled,
  });

  const lifecycle = useSessionLifecycle({
    sessionId,
    accessToken,
    initialView: initialStatusView,
    applyStatus: stream.applyStatus,
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
    enabled: showForm,
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
    if (!showChat) return; // form-only mode never opens a chat turn
    if (streamStatus !== 'idle') return;
    if (turnCount > 1) return;
    void kickoff();
  }, [autoStart, showChat, kickoff, streamStatus, turnCount]);

  // Keep the settle targets current without touching refs during render. The stream calls
  // `onTurnSettled` (and thus reads these) only after a turn settles — well after this effect.
  useEffect(() => {
    panelRefetchRef.current = panel.refetch;
    lifecycleRefetchRef.current = lifecycle.refetch;
  });

  const handleRevisit = useCallback(
    (slot: PanelSlotView) => {
      if (!stream.canSend) return;
      void stream.sendMessage(`I'd like to revisit my answer to: ${slot.prompt}`);
    },
    [stream]
  );

  // "both" mode toggle. Switching TO the form re-seeds it from the server so chat-inferred
  // answers appear; switching TO chat refetches the panel so it reflects the form's edits.
  const showFormView = useCallback(() => {
    setActiveView('form');
    form.refresh();
  }, [form]);
  const showChatView = useCallback(() => {
    setActiveView('chat');
    panel.refetch();
  }, [panel]);

  // Submitted → the conversation/form is done; show the confirmation in place of the workspace.
  if (stream.status === 'completed') {
    return (
      <SessionComplete
        sessionId={sessionId}
        accessToken={accessToken}
        answeredCount={lifecycle.view?.completion.answeredCount ?? null}
      />
    );
  }

  // A blocked session (respondent-paused, budget-capped, expired) is read-only for the form.
  const formBlocked =
    stream.status === 'not_active' ||
    stream.status === 'cost_capped' ||
    stream.status === 'expired';

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
          // Fresh sessions (autoStart) type the seeded greeting in, like a streamed reply;
          // resumes render their history instantly.
          animateOpening={autoStart}
          className="min-h-0 flex-1"
        />
      </div>
      <AnswerSlotPanel
        view={panel.view}
        loading={panel.loading}
        onRevisit={handleRevisit}
        canRevisit={stream.canSend}
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
        statuses={form.statuses}
        onChange={form.setValue}
        onFlush={form.flush}
        disabled={formBlocked}
        className="min-h-0 flex-1"
      />
    </div>
  );

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
        trailing={
          presentationMode === 'both' ? (
            <ModeToggle
              value={activeView}
              onChange={(v) => (v === 'form' ? showFormView() : showChatView())}
            />
          ) : undefined
        }
      />

      {presentationMode === 'both' ? (
        // Carousel: both surfaces live in one track that slides between them on toggle.
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className="flex h-full w-[200%] transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: activeView === 'form' ? 'translateX(-50%)' : 'translateX(0)' }}
          >
            <div
              role="tabpanel"
              aria-label="Chat"
              className="h-full min-h-0 w-1/2 shrink-0 overflow-hidden"
              inert={activeView !== 'chat'}
            >
              {chatSurface}
            </div>
            <div
              role="tabpanel"
              aria-label="Form"
              className="h-full min-h-0 w-1/2 shrink-0 overflow-hidden"
              inert={activeView !== 'form'}
            >
              {formSurface}
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">{showForm ? formSurface : chatSurface}</div>
      )}
    </div>
  );
}
