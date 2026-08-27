/**
 * Human-facing copy for each respondent layout — the ONE source of it.
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

import { RESPONDENT_LAYOUTS, type RespondentLayout } from '@/lib/app/questionnaire/types';

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
};

/** Just the labels, for the places that show a name without room for the description. */
export const RESPONDENT_LAYOUT_LABELS: Record<RespondentLayout, string> = Object.fromEntries(
  RESPONDENT_LAYOUTS.map((key) => [key, RESPONDENT_LAYOUT_META[key].label])
) as Record<RespondentLayout, string>;
