/**
 * Contrast optimiser — the one entry point.
 *
 * Audit the theme, ask the adviser which side of each failure should move, and assemble the result
 * the dialog renders. The interesting decisions are all about what happens when something is
 * missing, because for this feature "missing" is the ordinary case, not the exception:
 *
 *  - **Nothing fails.** `clean` is a real answer and the most common one for a brand that has been
 *    set up carefully. It has to say so out loud — an empty proposal list rendered as a blank panel
 *    reads as a broken feature, not as a passing check.
 *  - **A failure no shade can fix.** Reported in its own bucket rather than dropped. An accent with
 *    no version of itself that clears both grounds is genuinely stuck, and silently omitting it
 *    would let the admin apply the other proposals and believe the theme is now clean.
 *  - **No model.** The proposals stand, ranked by how little they move the brand, marked
 *    `degraded`. The arithmetic was never the model's job, so losing it costs judgement, not
 *    correctness.
 *
 * Persists nothing. The proposals reach a column only when the admin accepts them into the form and
 * saves it — the same contract brand import has, and for the same reason: this is cosmetics the
 * admin adjudicates, not a decision we are entitled to make for them.
 */

import { logger } from '@/lib/logging';

import type { DemoClientTheme } from '@/lib/app/questionnaire/theming';
import { auditTheme } from '@/lib/app/questionnaire/brand-contrast/audit';
import { advise, recommendDefault } from '@/lib/app/questionnaire/brand-contrast/advise';
import type { OptimiseResult } from '@/lib/app/questionnaire/brand-contrast/result';

export interface OptimiseInput {
  theme: DemoClientTheme | null;
  /** The client this is for, when there is one — absent on the create form. Cost context only. */
  demoClientId?: string;
}

export async function optimiseContrast(input: OptimiseInput): Promise<OptimiseResult> {
  const audited = auditTheme(input.theme);

  // A finding with no repairs is not a proposal — there is nothing to accept. Split before the
  // model is asked anything, so it is never handed a problem with an empty list of answers.
  //
  // In practice this bucket stays empty: a tint/shade ramp runs continuously from black to white,
  // and at the 3:1 UI threshold the band of lightnesses clearing both grounds is always wide enough
  // for the scan to cross. (At 4.5:1 it is roughly 0.008 wide, which is exactly why holding the
  // accent to the text threshold made every brand unfixable.) The branch stays because it is the
  // honest answer the day a stricter pair is added — a finding that reached neither bucket would
  // let the admin apply everything and believe the theme was readable.
  const fixable = audited.filter((pair) => pair.repairs.length > 0);
  const unfixable = audited.filter((pair) => pair.repairs.length === 0).map((pair) => pair.finding);

  if (fixable.length === 0) {
    return {
      outcome: unfixable.length > 0 ? 'unfixable' : 'clean',
      proposals: [],
      unfixable,
      degraded: false,
      summary:
        unfixable.length > 0
          ? summariseUnfixable(unfixable.length)
          : 'Every colour pairing on the respondent surface clears WCAG AA. Nothing to change.',
    };
  }

  let proposals = fixable.map(recommendDefault);
  let degraded = true;
  try {
    const advised = await advise({ audited: fixable, demoClientId: input.demoClientId });
    proposals = advised.proposals;
    degraded = advised.degraded;
  } catch (error) {
    // Unseeded agent, no provider, a provider that refused: all the same thing here. Logged at
    // info because it is a degradation the admin is told about, not a defect.
    logger.info('Brand contrast: advising unavailable, ranking the repairs ourselves', {
      error: error instanceof Error ? error.message : String(error),
      findings: fixable.length,
    });
  }

  return {
    outcome: 'proposed',
    proposals,
    unfixable,
    degraded,
    summary: summarise(proposals.length, unfixable.length, degraded),
  };
}

function summarise(proposed: number, stuck: number, degraded: boolean): string {
  const head =
    proposed === 1
      ? 'One pairing on the respondent surface is too low-contrast to read comfortably.'
      : `${proposed} pairings on the respondent surface are too low-contrast to read comfortably.`;
  const tail = stuck > 0 ? ` ${summariseUnfixable(stuck)}` : '';
  // Said plainly rather than hidden behind a badge: an admin accepting a suggestion is entitled to
  // know whether it was considered or merely the arithmetically smallest option.
  const note = degraded
    ? ' No AI adviser was available, so these are the smallest changes that work rather than a considered choice between them.'
    : '';
  return `${head} Each suggestion below is a shade of a colour already in the brand.${tail}${note}`;
}

function summariseUnfixable(count: number): string {
  return count === 1
    ? 'One more cannot be fixed by shading alone — it needs a different colour, not a lighter or darker one.'
    : `${count} more cannot be fixed by shading alone — they need different colours, not lighter or darker ones.`;
}
