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
import type {
  LayoutDefinition,
  LayoutRegistry,
} from '@/components/app/questionnaire/layouts/types';
import { DEFAULT_RESPONDENT_LAYOUT, type RespondentLayout } from '@/lib/app/questionnaire/types';

export const LAYOUT_REGISTRY = {
  classic: {
    label: 'ConQuest Classic',
    description:
      'The conversation with the live answer panel beside it. The default, and what every questionnaire has always looked like.',
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
