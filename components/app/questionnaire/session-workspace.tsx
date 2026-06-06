'use client';

/**
 * SessionWorkspace — the respondent split-screen: chat + live answer panel (F7.2).
 *
 * Owns the single {@link useQuestionnaireSessionStream} instance and the
 * {@link useAnswerPanel} fetch, then renders {@link QuestionnaireChat} and
 * {@link AnswerSlotPanel} side by side. One shared stream is what lets the panel's
 * "Revisit" action send a turn through the same loop the chat uses, and the panel
 * refetches whenever a turn settles (`onTurnSettled`).
 *
 * Layout: a single readable chat column with a fixed-width panel beside it on `lg`+;
 * below `lg` the panel is hidden and the chat is full-width (the F7.1 experience).
 * Both sit under the page's `BrandThemeProvider`, so the panel inherits the brand
 * CSS vars with no prop-drilling.
 */

import { useCallback } from 'react';

import { useQuestionnaireSessionStream } from '@/lib/hooks/use-questionnaire-session-stream';
import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { QuestionnaireChat } from '@/components/app/questionnaire/chat/questionnaire-chat';
import { AnswerSlotPanel } from '@/components/app/questionnaire/panel/answer-slot-panel';
import type {
  QuestionnaireChatStatus,
  QuestionnaireTurn,
} from '@/lib/app/questionnaire/chat/types';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

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
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
}

export function SessionWorkspace({
  sessionId,
  accessToken,
  initialTurns,
  initialStatus,
  initialPanel,
  voiceInputEnabled = false,
}: SessionWorkspaceProps) {
  const panel = useAnswerPanel({ sessionId, accessToken, initialView: initialPanel });

  const stream = useQuestionnaireSessionStream({
    sessionId,
    accessToken,
    initialTurns,
    initialStatus,
    onTurnSettled: panel.refetch,
  });

  const handleRevisit = useCallback(
    (slot: PanelSlotView) => {
      if (!stream.canSend) return;
      void stream.sendMessage(`I'd like to revisit my answer to: ${slot.prompt}`);
    },
    [stream]
  );

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]">
      <div className="min-h-0">
        <QuestionnaireChat
          sessionId={sessionId}
          accessToken={accessToken}
          stream={stream}
          voiceInputEnabled={voiceInputEnabled}
          className="h-full"
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
}
