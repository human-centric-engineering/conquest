/**
 * The respondent layout registry — every arrangement, and where each one puts every part.
 *
 * `satisfies LayoutRegistry` is the load-bearing line at the bottom. It resolves to
 * `Record<RespondentLayout, LayoutDefinition>`, whose `placements` is
 * `Record<RespondentSlotKey, SlotPlacement>` — so **a new slot key does not compile until every
 * layout here says where that part goes**, and a new layout does not compile until it has
 * classified all of them. Adding a value to `RESPONDENT_LAYOUTS` without an entry here fails the
 * same way, which is why that tuple grows only as layouts actually land.
 *
 * `placements` is a declaration, and a declaration can drift from the component beside it. Two
 * things stop that: `missingEssentialSlots` refuses a layout that omits anything a respondent
 * needs to finish, and the layout tests render each one with a sentinel per slot and assert every
 * `region`-placed part reaches the DOM.
 *
 * Resolution is deliberately total — {@link resolveLayout} never returns undefined. A questionnaire
 * carrying a layout name this build has never heard of (a rollback, a hand-edited row, a fork that
 * removed one) renders Classic rather than nothing.
 */

import { ClassicLayout } from '@/components/app/questionnaire/layouts/classic-layout';
import { FocusLayout } from '@/components/app/questionnaire/layouts/focus-layout';
import { BroadsheetLayout } from '@/components/app/questionnaire/layouts/broadsheet-layout';
import { HorizonLayout } from '@/components/app/questionnaire/layouts/horizon-layout';
import { RESPONDENT_LAYOUT_META } from '@/lib/app/questionnaire/layout/catalog';
import type {
  LayoutDefinition,
  LayoutRegistry,
} from '@/components/app/questionnaire/layouts/types';
import { DEFAULT_RESPONDENT_LAYOUT, type RespondentLayout } from '@/lib/app/questionnaire/types';

export const LAYOUT_REGISTRY = {
  classic: {
    // Copy comes from the shared catalog so the picker, the exported settings table and this
    // registry can never disagree about what a layout is called — see catalog.ts.
    ...RESPONDENT_LAYOUT_META.classic,
    Component: ClassicLayout,
    placements: {
      /* Identity */
      brandBand: { kind: 'region', region: 'above the workspace, in the brand provider' },

      /* Session chrome */
      lifecycleBar: { kind: 'region', region: 'strip along the top' },
      // Classic renders the pre-composed strip, which draws the bar internally. The atom exists
      // for layouts that decompose the strip; here it would be a second, duplicate bar.
      progress: { kind: 'region', region: 'inside the lifecycle strip' },
      sessionRef: { kind: 'region', region: "the intro splash's footer, else the lifecycle strip" },
      transcriptDownload: { kind: 'region', region: 'lifecycle strip, download slot' },
      modeToggle: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      textSize: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      reviewTrigger: { kind: 'region', region: 'lifecycle strip, trailing cluster (below lg)' },
      interviewerChip: { kind: 'region', region: 'lifecycle strip, trailing cluster' },

      /* Pre-conversation gates */
      splash: { kind: 'region', region: 'carousel page' },
      captureGate: { kind: 'region', region: 'carousel page' },
      personaPicker: { kind: 'region', region: 'carousel page' },

      /* The work itself */
      releaseNotice: {
        kind: 'region',
        region: 'head of the conversation column, above the history',
      },
      // History and current exchange stacked in one reading column, which is what a transcript has
      // always been. Classic keeps them together on purpose: the split exists so a layout CAN
      // separate them (Horizon does), not so every layout must.
      history: { kind: 'region', region: 'the conversation column, above the current exchange' },
      currentExchange: { kind: 'region', region: 'the conversation column, at its foot' },
      // Stacked directly beneath the conversation inside the shared card, which is where it has
      // always been.
      composer: { kind: 'region', region: 'foot of the conversation card, beneath the transcript' },
      formView: { kind: 'region', region: 'carousel page' },
      answersPanel: { kind: 'region', region: 'right column of the split (lg and up)' },
      answersDrawer: { kind: 'overlay', via: 'sheet' },

      /* Finishing */
      completionOffer: { kind: 'region', region: 'above the conversation and the form' },
      finalCheck: { kind: 'overlay', via: 'modal' },
      complete: { kind: 'region', region: 'takeover' },
      handoff: { kind: 'region', region: 'takeover' },
      personaSwitcher: { kind: 'overlay', via: 'modal' },
    },
  },

  focus: {
    ...RESPONDENT_LAYOUT_META.focus,
    Component: FocusLayout,
    placements: {
      /* Identity */
      brandBand: { kind: 'region', region: 'above the workspace, in the brand provider' },

      /* Session chrome */
      lifecycleBar: { kind: 'region', region: 'strip along the top' },
      progress: { kind: 'region', region: 'inside the lifecycle strip' },
      sessionRef: { kind: 'region', region: "the intro splash's footer, else the lifecycle strip" },
      transcriptDownload: { kind: 'region', region: 'lifecycle strip, download slot' },
      modeToggle: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      textSize: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      // Not `lg:hidden` as in Classic: with no panel on screen at any width, the trigger is the
      // ONLY route to the captured answers, so it has to be present at every width. The container
      // reads this placement to decide that, rather than the layout re-styling a node it was given.
      reviewTrigger: { kind: 'region', region: 'lifecycle strip, trailing cluster (all widths)' },
      interviewerChip: { kind: 'region', region: 'lifecycle strip, trailing cluster' },

      /* Pre-conversation gates */
      splash: { kind: 'region', region: 'carousel page' },
      captureGate: { kind: 'region', region: 'carousel page' },
      personaPicker: { kind: 'region', region: 'carousel page' },

      /* The work itself */
      releaseNotice: { kind: 'region', region: 'head of the single column' },
      history: { kind: 'region', region: 'the single column, above the current exchange' },
      currentExchange: { kind: 'region', region: 'the single column, at its foot' },
      composer: { kind: 'region', region: 'foot of the conversation card, beneath the transcript' },
      formView: { kind: 'region', region: 'carousel page' },
      // RELOCATED, not dropped — the whole point of this layout. The captured answers stay one tap
      // away in the review sheet at every width (see `answersDrawer`), which is why the trigger
      // above is always on screen. Omitting the panel is legal precisely because `answersPanel` is
      // not an essential slot; omitting the answers ENTIRELY would not be.
      answersPanel: {
        kind: 'omitted',
        because: 'review lives in the sheet at every width, so no panel rides beside the column',
      },
      answersDrawer: { kind: 'overlay', via: 'sheet' },

      /* Finishing */
      completionOffer: { kind: 'region', region: 'above the conversation and the form' },
      finalCheck: { kind: 'overlay', via: 'modal' },
      complete: { kind: 'region', region: 'takeover' },
      handoff: { kind: 'region', region: 'takeover' },
      personaSwitcher: { kind: 'overlay', via: 'modal' },
    },
  },
  broadsheet: {
    ...RESPONDENT_LAYOUT_META.broadsheet,
    Component: BroadsheetLayout,
    placements: {
      /* Identity */
      brandBand: { kind: 'region', region: 'above the workspace, in the brand provider' },

      /* Session chrome */
      // The composed strip, not a decomposed margin of atoms — see the layout's docblock: pause /
      // resume and the lifecycle action errors live only inside the strip and have no slot of their
      // own, so decomposing today would drop them silently.
      lifecycleBar: { kind: 'region', region: 'strip along the top' },
      progress: { kind: 'region', region: 'inside the lifecycle strip' },
      sessionRef: { kind: 'region', region: "the intro splash's footer, else the lifecycle strip" },
      transcriptDownload: { kind: 'region', region: 'lifecycle strip, download slot' },
      modeToggle: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      textSize: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      // As in Focus, and for the same mechanical reason: with no panel on screen at any width the
      // trigger is the only route to the captured answers, so it cannot carry Classic's `lg:hidden`.
      // The container reads this placement to decide that.
      reviewTrigger: { kind: 'region', region: 'lifecycle strip, trailing cluster (all widths)' },
      interviewerChip: { kind: 'region', region: 'lifecycle strip, trailing cluster' },

      /* Pre-conversation gates */
      splash: { kind: 'region', region: 'carousel page' },
      captureGate: { kind: 'region', region: 'carousel page' },
      personaPicker: { kind: 'region', region: 'carousel page' },

      /* The work itself */
      releaseNotice: { kind: 'region', region: 'head of the document column' },
      // One continuous page: the history runs into the current exchange with no seam, which is what
      // makes it a document rather than a chat log. Broadsheet's argument is about the composer, and
      // it has nothing to say about folding the conversation away.
      history: { kind: 'region', region: 'the document column, above the current exchange' },
      currentExchange: { kind: 'region', region: 'the document column, at its foot' },
      // THE point of this layout, and the reason `conversation` became two slots. The composer is
      // held still in the margin while the document scrolls beside it, rather than welded to the
      // foot of the transcript. Below `lg` the margin folds underneath, but the composer stays a
      // card of its own — it never rejoins the transcript.
      composer: {
        kind: 'region',
        region: 'the margin (lg and up), beneath the document below that',
        // The margin is a full-height column with only the completion offer above it, so the answer
        // box takes the rest of it. A document-shaped layout is for questionnaires whose answers are
        // long; a three-line box in a tall empty rail would say the opposite.
        fills: true,
        // Bare rail: nothing is drawn around the composer here, so it draws itself — a brand-tinted
        // box with its controls inside along the bottom edge. Classic and Focus leave this unset
        // and get the field-and-a-row form, because there a scrolling transcript is competing for
        // the same viewport and an empty four-line box would be taking it from the conversation.
        prominent: true,
      },
      formView: { kind: 'region', region: 'carousel page' },
      // Not a copy of Focus's reasoning: there is exactly one margin here and the composer is in it.
      // The answers stay one tap away in the sheet at every width, which is what makes omitting the
      // panel a relocation rather than a loss.
      answersPanel: {
        kind: 'omitted',
        because: 'the margin carries the composer, so review lives in the sheet at every width',
      },
      answersDrawer: { kind: 'overlay', via: 'sheet' },

      /* Finishing */
      // In the margin with the composer, not above the document: answering and finishing are the two
      // things the respondent DOES, and the document is the thing they read.
      completionOffer: { kind: 'region', region: 'the margin, above the composer' },
      finalCheck: { kind: 'overlay', via: 'modal' },
      complete: { kind: 'region', region: 'takeover' },
      handoff: { kind: 'region', region: 'takeover' },
      personaSwitcher: { kind: 'overlay', via: 'modal' },
    },
  },

  horizon: {
    ...RESPONDENT_LAYOUT_META.horizon,
    Component: HorizonLayout,
    placements: {
      /* Identity */
      brandBand: { kind: 'region', region: 'above the workspace, in the brand provider' },

      /* Session chrome */
      // The composed strip, for the same reason as everywhere else: pause / resume and the
      // lifecycle action errors have no slot of their own yet, so decomposing it would drop them
      // silently. A one-question layout is the most likely candidate to want the atoms one day.
      lifecycleBar: { kind: 'region', region: 'strip along the top' },
      progress: { kind: 'region', region: 'inside the lifecycle strip' },
      sessionRef: { kind: 'region', region: "the intro splash's footer, else the lifecycle strip" },
      transcriptDownload: { kind: 'region', region: 'lifecycle strip, download slot' },
      modeToggle: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      textSize: { kind: 'region', region: 'lifecycle strip, trailing cluster' },
      // As in Focus and Broadsheet, and for the same mechanical reason: no panel on screen at any
      // width makes this the only route to the captured answers, so it cannot carry Classic's
      // `lg:hidden`. The container reads this placement to decide that.
      reviewTrigger: { kind: 'region', region: 'lifecycle strip, trailing cluster (all widths)' },
      interviewerChip: { kind: 'region', region: 'lifecycle strip, trailing cluster' },

      /* Pre-conversation gates */
      splash: { kind: 'region', region: 'carousel page' },
      captureGate: { kind: 'region', region: 'carousel page' },
      personaPicker: { kind: 'region', region: 'carousel page' },

      /* The work itself */
      // On the stage, NOT inside the disclosure with the history — the reason this became a slot of
      // its own. A "your conversation is being recorded" notice one gesture out of sight is not a
      // notice, and it is the one part of the old transcript that must not move when the rest does.
      releaseNotice: { kind: 'region', region: 'head of the stage, above the disclosure' },
      // THE point of this layout, and the reason `transcript` became two slots. Everything before
      // the current exchange folds into a native `<details>` above the stage: one gesture away, and
      // therefore available rather than dropped. The container resolves this slot to `null` when
      // there is no history at all, so the disclosure is never offered onto nothing.
      history: { kind: 'overlay', via: 'gesture' },
      currentExchange: { kind: 'region', region: 'the stage, centred in the column' },
      // Welded to the foot of the stage in one card, as in Classic. Broadsheet's move — the box held
      // still in a margin — solves a problem this layout does not have: there is never enough on
      // screen here for the composer to scroll away from the respondent.
      composer: {
        kind: 'region',
        region: 'foot of the conversation card, beneath the stage',
        // The one place Horizon and Classic must NOT look alike. Everything else is folded away
        // here, so the answer box is the only other thing on screen and there is open space above
        // it: it gets the surface, the controls inside along its bottom edge, and a prose-height
        // opening, because the layout's whole argument is *this question, and your answer to it*.
        // Not `fills` — Broadsheet's margin is a column with nothing else in it and the box may as
        // well be the column; the stage above this one still needs its room.
        prominent: true,
      },
      formView: { kind: 'region', region: 'carousel page' },
      // Same outcome as Focus and Broadsheet, third distinct reason: a panel listing every answer
      // captured so far is precisely the wall of accumulated conversation this layout exists to put
      // away. Review stays one tap into the sheet at every width.
      answersPanel: {
        kind: 'omitted',
        because:
          'a running list of every answer is the accumulation this layout exists to fold away; review lives in the sheet at every width',
      },
      answersDrawer: { kind: 'overlay', via: 'sheet' },

      /* Finishing */
      // Above the stage rather than in the margin (Broadsheet) — there is no margin here, and a
      // finish affordance under the answer box would sit between the respondent and the one thing
      // the layout asks them to do.
      completionOffer: { kind: 'region', region: 'above the conversation and the form' },
      finalCheck: { kind: 'overlay', via: 'modal' },
      complete: { kind: 'region', region: 'takeover' },
      handoff: { kind: 'region', region: 'takeover' },
      personaSwitcher: { kind: 'overlay', via: 'modal' },
    },
  },
} satisfies LayoutRegistry;

/**
 * The definition for a layout name, falling back to Classic for anything unrecognised.
 *
 * Takes a plain `string` rather than `RespondentLayout` on purpose: the value reaching a
 * respondent page came out of a database column and has already been narrowed once, but this is
 * the last stop before it selects a component, and a blank surface is a far worse failure than a
 * questionnaire quietly rendering the default.
 */
export function resolveLayout(layout: string | null | undefined): LayoutDefinition {
  // `Object.hasOwn`, not a bare index-and-`??`. Indexing a plain object with an arbitrary string
  // walks the prototype chain, so a stored value of `constructor`, `toString` or `valueOf` returns
  // an inherited FUNCTION — truthy, so the `??` never fires — and the caller then destructures
  // `Component` and `placements` off it as `undefined` and crashes on `placements.answersPanel`.
  // That is precisely the blank surface this fallback exists to prevent, arrived at by the one
  // route the fallback did not cover. Unreachable through the admin PATCH (a Zod enum) or the read
  // narrowing today, which is exactly why it would have sat here unnoticed.
  if (typeof layout === 'string' && Object.hasOwn(LAYOUT_REGISTRY, layout)) {
    return LAYOUT_REGISTRY[layout as RespondentLayout];
  }
  return LAYOUT_REGISTRY[DEFAULT_RESPONDENT_LAYOUT];
}
