'use client';

/**
 * ConQuest Classic — the arrangement the respondent surface has always had, and the default
 * everywhere.
 *
 * A lifecycle strip across the top, then a carousel of surfaces: the pre-conversation gates
 * (intro, details, interviewer) followed by the conversation and the form. The conversation
 * surface is itself a split — conversation on the left, live answer panel on the right from `lg`
 * up, with the panel's mobile twin (a bottom sheet) standing in below that. The conversation's own
 * two halves stay stacked in one card here (see `ConversationFrame`); placing them apart is what
 * Broadsheet does with the same two slots.
 *
 * This file is a faithful extraction, not a redesign: it is the JSX that used to live inside
 * `SessionWorkspace`, moved behind the layout contract with no behavioural change. Anything that
 * looks odd here is load-bearing and the comment beside it says why — `overflow-clip` rather than
 * `overflow-hidden`, the absolutely-positioned carousel cells, the `h-full` that only applies when
 * the panel is hidden.
 *
 * Reads nothing and fetches nothing: every part arrives already built in `slots`, and every
 * decision it needs has already been made on `state`.
 */

import { cn } from '@/lib/utils';
import { RESPONDENT_SPLIT } from '@/lib/app/questionnaire/layout';
import { ConversationFrame } from '@/components/app/questionnaire/chat/conversation-frame';
import { TranscriptColumn } from '@/components/app/questionnaire/chat/transcript-column';
import { SurfaceCarousel } from '@/components/app/questionnaire/layouts/surface-carousel';
import type { RespondentLayoutProps } from '@/components/app/questionnaire/layouts/types';
import type { WorkspaceView } from '@/lib/hooks/use-session-workspace';

export function ClassicLayout({ slots, state }: RespondentLayoutProps) {
  const { showPanel } = state;

  // The conversation column: the submit/finish affordance above the transcript. Takes the full
  // height only when there is no panel beside it — with a panel, the grid track governs.
  //
  // The conversation's parts are four separate slots so that a layout CAN put them apart; Classic
  // does not, so it stacks them back into the single card they have always shared: the notice at the
  // head, the history behind the current exchange, the answer box beneath both. The reading column
  // comes from `TranscriptColumn` and the card and its hairline seam from `ConversationFrame`,
  // rather than being drawn here, so the layouts that share this arrangement cannot drift apart on a
  // detail none of them means to own.
  const chatColumn = (
    <div className={cn('flex min-h-0 flex-col gap-3', !showPanel && 'h-full')}>
      {/* P21: the section strip is chrome, and Classic has the room, so it sits above the card it
          bounds rather than inside it. Renders nothing on an unsectioned questionnaire. */}
      {slots.sectionTabs}
      {slots.completionOffer}
      <ConversationFrame
        className="min-h-0 flex-1"
        transcript={
          <TranscriptColumn>
            {slots.releaseNotice}
            {slots.history}
            {slots.currentExchange}
          </TranscriptColumn>
        }
        composer={slots.composer}
      />
      {/* P21: beside the answer box, because finishing a section is the other thing the respondent
          DOES here — and below the card, so it never competes with the composer for its width. */}
      {slots.sectionClose}
    </div>
  );

  const chatSurface = showPanel ? (
    // The conversation ⇄ panel split. Track widths ladder up with the viewport (see
    // RESPONDENT_SPLIT) so a large display gives the panel real room instead of pouring every
    // extra pixel into the transcript's line length.
    <div className={cn('grid h-full min-h-0', RESPONDENT_SPLIT)}>
      {chatColumn}
      {slots.answersPanel}
    </div>
  ) : (
    // Chat-only: no split at all, so the conversation gets the shell's full width at every
    // breakpoint rather than an empty panel track beside it.
    chatColumn
  );

  const formSurface = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {slots.completionOffer}
      {slots.formView}
    </div>
  );

  const surfaceFor = (view: WorkspaceView) => {
    switch (view) {
      case 'intro':
        return slots.splash;
      case 'capture':
        return slots.captureGate;
      case 'persona':
        return slots.personaPicker;
      case 'form':
        return formSurface;
      default:
        return chatSurface;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {slots.finalCheck}
      {slots.personaSwitcher}
      {slots.lifecycleBar}
      {slots.answersDrawer}

      <SurfaceCarousel state={state} surfaceFor={surfaceFor} />
    </div>
  );
}
