'use client';

/**
 * Focus — one calm column at every width, with the captured answers a tap away.
 *
 * Classic hands the extra width of a large display to the answer panel. Focus spends it on nothing
 * at all: the conversation keeps a deliberately narrow measure and the page stays quiet around it.
 * That suits a phone, an embed or an iframe (where a two-column split never had room anyway), and
 * it suits a conversation the respondent should sit with rather than scan.
 *
 * The important thing it demonstrates — and the reason it is the second layout rather than a
 * fourth — is that a layout may **relocate** a part instead of dropping it. The answer panel is not
 * on screen here, so `answersPanel` is `omitted`; but the captured answers are still one tap away
 * in the review sheet at every width, which is why `answersDrawer` is an `overlay` and the review
 * trigger loses Classic's `lg:hidden`. Nothing is lost, and the placement map says so out loud.
 *
 * Distinct from `answerSlotPanelScope: 'hidden'`, which is a different decision at a different
 * level: that removes the answers surface altogether (no panel, no sheet, no trigger). Focus keeps
 * it and moves it. The two compose — a Focus questionnaire with the scope hidden simply has no
 * review affordance, exactly as it would under Classic.
 */

import type { CSSProperties } from 'react';

import { ConversationFrame } from '@/components/app/questionnaire/chat/conversation-frame';
import { TranscriptColumn } from '@/components/app/questionnaire/chat/transcript-column';
import { SurfaceCarousel } from '@/components/app/questionnaire/layouts/surface-carousel';
import type { RespondentLayoutProps } from '@/components/app/questionnaire/layouts/types';
import type { WorkspaceView } from '@/lib/hooks/use-session-workspace';

/**
 * A tighter reading measure than the 42rem default.
 *
 * `--cq-chat-measure` is declared with a fallback in `app/globals.css` and set nowhere else, so
 * this costs one custom property rather than a competing width rule. It multiplies with the
 * respondent's own text-size preference and the viewport scale exactly as the default does — so a
 * respondent who needs larger text still gets a proportionally wider column, not a cramped one.
 */
const FOCUS_MEASURE: CSSProperties & Record<'--cq-chat-measure', string> = {
  '--cq-chat-measure': '38rem',
};

export function FocusLayout({ slots, state }: RespondentLayoutProps) {
  // No panel track at any width — the conversation simply takes the column. Its parts stay stacked
  // in one card, exactly as in Classic: Focus narrows the measure, it does not relocate the composer
  // (Broadsheet's move) or fold the history away (Horizon's).
  const chatSurface = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* P21: the section control and the finish control on one line above the card. Both are a
          line of text until pressed, which is the only chrome this layout will carry. */}
      <div className="flex items-center justify-between gap-2 empty:hidden">
        {slots.sectionTabs}
        {slots.sectionClose}
      </div>
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
    </div>
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
    <div className="flex h-full min-h-0 flex-col gap-3" style={FOCUS_MEASURE}>
      {slots.finalCheck}
      {slots.personaSwitcher}
      {slots.lifecycleBar}
      {slots.answersDrawer}

      <SurfaceCarousel state={state} surfaceFor={surfaceFor} />
    </div>
  );
}
