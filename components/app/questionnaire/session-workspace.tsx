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

import { useCallback, useEffect, useRef } from 'react';

import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { useSessionLifecycle } from '@/lib/hooks/use-session-lifecycle';
import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';
import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';
import type {
  QuestionnaireChatStatus,
  QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';
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
}

export function SessionWorkspace({
  sessionId,
  accessToken,
  initialTurns,
  initialStatus,
  initialPanel,
  initialStatusView,
  voiceInputEnabled = false,
}: SessionWorkspaceProps) {
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

  // Submitted → the conversation is done; show the confirmation in place of the workspace.
  if (stream.status === 'completed') {
    return <SessionComplete answeredCount={lifecycle.view?.completion.answeredCount ?? null} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <SessionLifecycleBar
        view={lifecycle.view}
        paused={stream.status === 'not_active'}
        busy={lifecycle.busy}
        actionError={lifecycle.actionError}
        canPause={lifecycle.canPause}
        canResume={lifecycle.canResume}
        onPause={() => void lifecycle.pause()}
        onResume={() => void lifecycle.resume()}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]">
        <div className="flex min-h-0 flex-col gap-3">
          {lifecycle.canSubmit && (
            <CompletionOffer onSubmit={() => void lifecycle.submit()} busy={lifecycle.busy} />
          )}
          <QuestionnaireChat
            sessionId={sessionId}
            accessToken={accessToken}
            stream={stream}
            voiceInputEnabled={voiceInputEnabled}
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
    </div>
  );
}
