'use client';

/**
 * Horizon — one question at a time, with the conversation so far one gesture behind it.
 *
 * Classic, Focus and Broadsheet all show the whole conversation and let it grow: the newest
 * question arrives at the bottom of a column that gets longer every turn. That is right for
 * something that reads as a conversation. It is wrong when the questionnaire is long, or the
 * questions are demanding, or the respondent is on a phone on a train — there the scroll-back is
 * not context, it is a wall of text between them and the thing they are being asked now.
 *
 * So here the current exchange — their last answer, and everything the interviewer has said since —
 * sits alone on a centred stage, and everything before it is folded into a disclosure above. The
 * history is one tap away rather than gone, which is the difference between a layout that
 * simplifies and one that hides.
 *
 * ## What it is for, structurally
 *
 * This is the layout the `history` / `currentExchange` split was made for, and the second time the
 * contract has paid for itself. Before the split there was one `transcript` node containing every
 * turn, the reveal queue, the question card and the correction strip; a one-question layout would
 * have had to reach inside it and re-derive which turns are current — the second derivation the
 * whole contract exists to prevent. Instead it places two nodes, and the boundary between them is
 * computed once, above every layout (`conversation-context.tsx`, `chat/exchange.ts`).
 *
 * The disclosure is a native `<details>`, not a piece of state this component keeps. A layout owns
 * arrangement and nothing else, and "is the history open" is arrangement — but it is also the kind
 * of thing that grows into a hook, then into a gate, then into a second copy of behaviour. The
 * element that already does it costs nothing and keeps the rule intact: keyboard, screen readers
 * and the browser's own find-in-page all work without a line of ours.
 *
 * ## What it keeps, and why
 *
 * The pre-composed `lifecycleBar`, like every layout so far — pause / resume and the lifecycle
 * action errors live only inside the strip and have no slot of their own, so decomposing it today
 * would drop them silently.
 *
 * `releaseNotice` stays on the stage rather than riding into the disclosure with the history, which
 * is exactly why it became a slot of its own with this layout: a "your conversation is being
 * recorded" notice folded behind a gesture is not a notice. It is the one part of the old
 * transcript that must not move when the rest of it does.
 *
 * The measure is left alone — no `--cq-chat-measure` of its own, unlike Focus (38rem) and
 * Broadsheet (52rem). Horizon's argument is about HOW MUCH is on screen, not how wide the line is,
 * and setting a value here would imply the two are connected.
 */

import { ChevronDown } from 'lucide-react';

import { ConversationFrame } from '@/components/app/questionnaire/chat/conversation-frame';
import { TranscriptColumn } from '@/components/app/questionnaire/chat/transcript-column';
import { SurfaceCarousel } from '@/components/app/questionnaire/layouts/surface-carousel';
import type { RespondentLayoutProps } from '@/components/app/questionnaire/layouts/types';
import type { WorkspaceView } from '@/lib/hooks/use-session-workspace';

export function HorizonLayout({ slots, state }: RespondentLayoutProps) {
  // The stage: the current exchange, centred in the column rather than sitting at the top of it, so
  // a single question reads as the page's subject and not as the last line of something longer.
  // `TranscriptColumn` supplies the scroll box, the respondent's text scale and the measure — the
  // same column Classic reads in, which is the point: Horizon changes what is on it, not how it
  // reads.
  const stage = (
    <TranscriptColumn centred>
      {/* Never inside the disclosure below. See the docblock. */}
      {slots.releaseNotice}
      {/* `null` until there IS a history — the container decides that, so the disclosure can never
          offer to open onto nothing (a fresh session's opening burst is all current exchange). */}
      {slots.history ? (
        <details
          // The chevron turns over when the disclosure opens — the only state this layout has, and
          // the browser is keeping it.
          className="[&[open]>summary_svg]:rotate-180"
          // Whether the history is folded away IS this layout, and there is nothing else to assert
          // it on: `registry.test.tsx` skips `overlay` placements, so without a handle here a
          // Horizon that quietly rendered the history inline would pass every mechanical check
          // while being Focus under another name. Same reasoning as `workspace-scale-root`.
          data-testid="horizon-history"
        >
          {/* `list-none` retires the marker in modern browsers; the WebKit pseudo-element needs
              saying separately, and it belongs to the summary rather than the details. */}
          <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs transition-colors [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" aria-hidden="true" />
            Earlier in this conversation
          </summary>
          {/* The same rhythm the column uses between its own blocks, so opening the history reads
              as more of the same conversation rather than as a panel that appeared. */}
          <div className="mt-6 flex flex-col gap-6">{slots.history}</div>
        </details>
      ) : null}
      {slots.currentExchange}
    </TranscriptColumn>
  );

  // The answer box stays welded to the foot of the stage, in one card. Broadsheet's move — the box
  // held still in a margin — solves a problem Horizon does not have: there is never enough on screen
  // here for the composer to scroll away from the respondent.
  const chatSurface = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* P21. Both stay on screen, and the section control can now do so honestly: it is one line
          naming where they are, not the permanent list of seven areas this layout folds away. The
          close control was always the exception — an action on the CURRENT question, not a record
          of past ones, and folding it away would fold away the way forward. */}
      <div className="flex items-center justify-between gap-2 empty:hidden">
        {slots.sectionTabs}
        {slots.sectionClose}
      </div>
      {slots.completionOffer}
      <ConversationFrame className="min-h-0 flex-1" transcript={stage} composer={slots.composer} />
    </div>
  );

  // The form is a form: it shows every question at once by definition, so a one-question-at-a-time
  // stage has nothing to say about it. Arranged exactly as it is everywhere else.
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
