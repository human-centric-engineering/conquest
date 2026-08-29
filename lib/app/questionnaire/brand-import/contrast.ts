/**
 * Brand import — contrast annotation.
 *
 * A brand can legitimately be low-contrast, so this never rejects a proposal and never substitutes
 * a "safer" colour. It annotates: when the ink we propose does not read against the canvas we
 * propose, both fields carry a caveat the dialog shows beside the swatch.
 *
 * That is the same judgement the demo-client form already makes on hand-entered colours — a soft
 * amber warning that never blocks the save (`demo-client-form.tsx`) — so an imported pair and a
 * typed pair are held to one standard. It reuses the form's `contrastRatio` and
 * `MIN_CONTRAST_RATIO` rather than re-deriving WCAG here, because two implementations of the same
 * threshold would eventually disagree and the admin would see a warning on one screen and not the
 * other.
 *
 * Pure: no Prisma / Next / sharp / LLM.
 */

import { MIN_CONTRAST_RATIO, contrastRatio } from '@/lib/app/questionnaire/theming';
import type { ImportableField, ProposedField } from '@/lib/app/questionnaire/brand-import/result';

/**
 * Add a contrast caveat to a proposed canvas/ink pair when they do not read against each other.
 *
 * Mutates nothing — returns a new field bag, because the caller assembles proposals from several
 * sources and an in-place edit would make the order of those steps significant.
 *
 * Only annotates when BOTH are proposed. With a canvas and no ink the theme resolver derives an ink
 * that reads by construction (`readableTextColor`), so there is nothing to warn about; warning
 * anyway would train admins to ignore the message.
 */
export function annotateContrast(
  fields: Partial<Record<ImportableField, ProposedField>>
): Partial<Record<ImportableField, ProposedField>> {
  const canvas = fields.canvasColor;
  const ink = fields.inkColor;
  if (!canvas || !ink) return fields;

  const ratio = contrastRatio(canvas.value, ink.value);
  if (ratio === null || ratio >= MIN_CONTRAST_RATIO) return fields;

  const caveat =
    `These two give ${ratio.toFixed(1)}:1 contrast, below the WCAG AA threshold of ` +
    `${MIN_CONTRAST_RATIO}:1. Accept them if that is the brand, or leave the ink blank and we will ` +
    `derive one that reads.`;

  return {
    ...fields,
    canvasColor: { ...canvas, caveat },
    inkColor: { ...ink, caveat },
  };
}
