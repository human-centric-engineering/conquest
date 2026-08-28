/**
 * Human-facing copy for the respondent layouts, designs and chrome modes — the ONE source of it.
 *
 * Three surfaces need to name a layout: the admin picker in the config editor, the settings
 * registry (which feeds the Questionnaire Pack's shareable "Experience setup" table), and the
 * layout registry itself. The codebase already shows what happens when copy like this is declared
 * per-surface — `PRESENTATION_MODE_LABELS`, `ANSWER_SLOT_PANEL_SCOPE_LABELS` and
 * `REASONING_PLACEMENT_LABELS` each exist twice today, verbatim, with nothing linking the copies.
 * A client-facing PDF disagreeing with the screen the admin configured it on is a small, avoidable
 * embarrassment, so this one is declared once.
 *
 * Lives in `lib/` rather than beside the components because `settings-registry.ts` consumes it
 * server-side, and pulling a React module into that path would drag the whole component tree into
 * the pack exporter. Pure data: no React, no Prisma, no DOM.
 */

import {
  RESPONDENT_CHROMES,
  RESPONDENT_DESIGNS,
  RESPONDENT_LAYOUTS,
  type RespondentChrome,
  type RespondentDesign,
  type RespondentLayout,
} from '@/lib/app/questionnaire/types';

export interface RespondentLayoutMeta {
  /** Short name, as shown in the picker and in the exported settings table. */
  label: string;
  /** One line, in the admin's language, on what this arrangement is *for*. */
  description: string;
}

export const RESPONDENT_LAYOUT_META: Record<RespondentLayout, RespondentLayoutMeta> = {
  classic: {
    label: 'ConQuest Classic',
    description:
      'The conversation with the captured answers beside it. The default, and what every questionnaire has always looked like.',
  },
  focus: {
    label: 'Focus',
    description:
      'One calm column at every screen size, with the captured answers a tap away rather than alongside. Good on a phone, in an embed, or when the conversation deserves the whole page.',
  },
  broadsheet: {
    label: 'Broadsheet',
    description:
      'The conversation reads as a document, with the answer box held still in the margin beside it instead of moving with the text. Good for long questions people need to read and re-read, on a laptop or larger.',
  },
  horizon: {
    label: 'Horizon',
    description:
      'One question at a time, with everything already answered folded away above it. Good for long questionnaires, demanding questions, and anyone answering on a phone.',
  },
};

/** Just the labels, for the places that show a name without room for the description. */
export const RESPONDENT_LAYOUT_LABELS: Record<RespondentLayout, string> = Object.fromEntries(
  RESPONDENT_LAYOUTS.map((key) => [key, RESPONDENT_LAYOUT_META[key].label])
) as Record<RespondentLayout, string>;

/**
 * Human-facing copy for each DESIGN — the third axis, and the one an admin is most likely to
 * confuse with the others, so the copy works hardest here at saying what it is NOT.
 *
 * Written for an admin choosing on a client's behalf, usually with the client in the room: it
 * describes the feeling and who it suits, not the mechanism. "Square corners and hairline rules" is
 * a decision somebody can have an opinion about; "resets `--radius-*` to 0" is not.
 */
export const RESPONDENT_DESIGN_META: Record<RespondentDesign, RespondentLayoutMeta> = {
  rounded: {
    label: 'ConQuest Rounded',
    description:
      'Soft corners and warm rules — the friendly, conversational look every questionnaire has always had. The default, and the safe choice for anything that should feel like a chat.',
  },
  press: {
    label: 'Press',
    description:
      'Straight lines, hairline rules and no shadows — the register of a printed report. Suits serious instruments, professional audiences, and clients whose own brand is spare. Only the answer box keeps a soft corner, because it is the one thing a respondent touches.',
  },
  marque: {
    label: 'Marque',
    description:
      'Straight lines, and the client’s brand built into the page rather than sat on top of it: their logo signs every question the interviewer asks, an accent spine runs down the conversation, and the header is a block of their colour. Best for a client with a strong mark who wants the questionnaire to be unmistakably theirs.',
  },
};

/** Just the labels — the exported settings table and anywhere else without room for a description. */
export const RESPONDENT_DESIGN_LABELS: Record<RespondentDesign, string> = Object.fromEntries(
  RESPONDENT_DESIGNS.map((key) => [key, RESPONDENT_DESIGN_META[key].label])
) as Record<RespondentDesign, string>;

/**
 * Human-facing copy for each chrome mode, declared here for the same reason the layouts are: the
 * settings tab, the exported settings table and any surface that has to name the choice all read
 * one source.
 *
 * The copy is written for the admin choosing on a client's behalf, so it says what the RESPONDENT
 * sees rather than naming the mechanism — "no ConQuest branding" is the decision being made;
 * "renders no AppHeader" is an implementation detail nobody outside this repo can act on.
 */
export const RESPONDENT_CHROME_META: Record<RespondentChrome, RespondentLayoutMeta> = {
  full: {
    label: 'Full ConQuest',
    description:
      'The usual ConQuest header and footer around the questionnaire. The default, and what every questionnaire link has always looked like.',
  },
  co_branded: {
    label: 'Co-branded',
    description:
      'A slim ConQuest line above the client’s own branding, and nothing below it. Says who built it without offering respondents a menu mid-questionnaire.',
  },
  white_label: {
    label: 'White label',
    description:
      'The questionnaire on its own, with no ConQuest branding at all. For clients presenting it as their own, and for embedding it in someone else’s page.',
  },
};

/** Just the labels — the exported settings table and anywhere else without room for a description. */
export const RESPONDENT_CHROME_LABELS: Record<RespondentChrome, string> = Object.fromEntries(
  RESPONDENT_CHROMES.map((key) => [key, RESPONDENT_CHROME_META[key].label])
) as Record<RespondentChrome, string>;
