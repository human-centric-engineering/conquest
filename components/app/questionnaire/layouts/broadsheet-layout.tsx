'use client';

/**
 * Broadsheet — the conversation as a document, with the answer box in the margin beside it.
 *
 * Classic and Focus both keep the composer where a chat app puts it: welded to the bottom of the
 * transcript, inside the same card, moving up and down with it. That is right for something that
 * reads as a chat. It is wrong for a questionnaire whose questions are long enough to *read* —
 * a policy consultation, a due-diligence pack, anything where the respondent scrolls back to check
 * what was asked three questions ago and finds the box they were typing in has scrolled away with
 * it.
 *
 * So here the transcript is the page and the composer is the margin: a fixed rail from `lg` up that
 * does not move while the document scrolls beside it. The submit / finish affordance sits in the
 * same rail, directly above the box, because finishing and answering are the two things the
 * respondent *does* and they belong together — the document is the thing they read.
 *
 * Below `lg` there is no margin to speak of, so the rail folds underneath and the composer sits in
 * its own card beneath the document. It stays a card of its own rather than rejoining the
 * transcript, so the layout reads the same way at every width: two objects, a document and a box,
 * not one object that changes shape at a breakpoint.
 *
 * ## What it is for, structurally
 *
 * This is the layout the `transcript` / `composer` slot split was made for. It could not have been
 * written while `conversation` was a single slot — not without reaching inside `QuestionnaireChat`
 * and re-deriving the reveal-queue gate that keeps the composer shut until a reply has finished
 * typing in, which is exactly the second derivation the layout contract exists to prevent. Instead
 * it places two nodes, and the shared clock rides the `ConversationProvider` above every layout.
 *
 * ## What it keeps, and why
 *
 * It still renders the pre-composed `lifecycleBar` rather than decomposing it into a margin of
 * atoms, which a document-shaped layout might otherwise want. That is a real limit, not a
 * preference: pause / resume and the lifecycle action errors exist only inside the composed strip
 * and have no slot of their own, so a layout that dropped the bar today would drop them silently —
 * precisely the failure the slot contract exists to make impossible. The atoms to decompose it
 * land with the first layout that genuinely cannot use the strip.
 *
 * The answers panel is `omitted`, as in Focus, and for a reason specific to this shape rather than
 * a copied one: there is exactly one margin and the composer is in it. Review stays one tap away in
 * the sheet at every width, which is why the review trigger loses Classic's `lg:hidden` here too.
 */

import type { CSSProperties } from 'react';

import { TranscriptColumn } from '@/components/app/questionnaire/chat/transcript-column';
import { SurfaceCarousel } from '@/components/app/questionnaire/layouts/surface-carousel';
import type { RespondentLayoutProps } from '@/components/app/questionnaire/layouts/types';
import type { WorkspaceView } from '@/lib/hooks/use-session-workspace';

/**
 * A wider reading measure than the 42rem default — the opposite move to Focus, from the same one
 * custom property (`--cq-chat-measure`, declared with a fallback in `globals.css`).
 *
 * A document wants a longer line than a chat bubble does. 52rem is about 95 characters at the base
 * size, past the classic prose optimum but comfortably inside it once the respondent's own text-size
 * preference and the viewport scale multiply in — which they do, since the measure is expressed in
 * terms of both. The rail beside it is unaffected: the measure is a max-width, and the rail is
 * narrower than any value it can resolve to.
 */
const BROADSHEET_MEASURE: CSSProperties & Record<'--cq-chat-measure', string> = {
  '--cq-chat-measure': '52rem',
};

export function BroadsheetLayout({ slots, state }: RespondentLayoutProps) {
  const chatSurface = (
    // One grid, two behaviours. Below `lg` it is a single column of two rows — the document taking
    // the remaining height (`minmax(0,1fr)`, not `1fr`, so a long unbroken token cannot push the row
    // taller than its share) and the rail sizing to its content beneath it. From `lg` it becomes two
    // columns on one row, and the rail is the margin.
    //
    // The transcript is NOT re-rendered per breakpoint. Two trees would mean two mounted
    // transcripts, two scroll positions and two `scrollIntoView` calls fighting each other on every
    // token — so the shape changes by grid template alone.
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 lg:grid-cols-[minmax(0,1fr)_26rem] lg:grid-rows-1 lg:gap-6">
      {/* The document: the notice, the history and the current exchange read as one continuous
          page, in its own card, filling the column and scrolling internally. The composer is not
          inside it, so the shared `ConversationFrame` — which exists to stack the two — is
          deliberately not used; `TranscriptColumn` still is, because the reading column itself
          (scroll box, text scale, measure) is the same one every layout reads in. */}
      <div className="bg-card flex min-h-0 flex-col rounded-xl border">
        <TranscriptColumn>
          {slots.releaseNotice}
          {slots.history}
          {slots.currentExchange}
        </TranscriptColumn>
      </div>

      {/* The margin — a full-height column, with the answer box taking everything the completion
          offer does not. The rail could size to its content instead (`self-start`), but a
          three-line box adrift in a tall empty margin says "jot something down", and this layout
          exists for questionnaires whose answers run long. The composer's own
          `placements.composer.fills` declaration is what lets it grow into the space; the layout
          only supplies the space.

          No card around it: the composer draws its own bordered surface, so wrapping it in another
          would be two rectangles saying the same thing. */}
      <div className="flex min-h-0 flex-col gap-3">
        {slots.completionOffer}
        {slots.composer ? <div className="min-h-0 flex-1">{slots.composer}</div> : null}
      </div>
    </div>
  );

  // The form is a form: it wants the page, not a margin. Broadsheet's shape is an argument about
  // reading a conversation, and it has nothing to say about a sectioned form — so this surface is
  // arranged exactly as it is everywhere else, and the completion offer returns to the top where
  // the form's own submit expects it.
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
    <div className="flex h-full min-h-0 flex-col gap-3" style={BROADSHEET_MEASURE}>
      {slots.finalCheck}
      {slots.personaSwitcher}
      {slots.lifecycleBar}
      {slots.answersDrawer}

      <SurfaceCarousel state={state} surfaceFor={surfaceFor} />
    </div>
  );
}
