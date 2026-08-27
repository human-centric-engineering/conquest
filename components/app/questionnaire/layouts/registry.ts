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
      conversation: { kind: 'region', region: 'carousel page, left column of the split' },
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
      conversation: { kind: 'region', region: 'the single column' },
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
  const key = layout as RespondentLayout;
  return LAYOUT_REGISTRY[key] ?? LAYOUT_REGISTRY[DEFAULT_RESPONDENT_LAYOUT];
}
