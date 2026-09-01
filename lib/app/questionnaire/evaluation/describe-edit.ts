/**
 * What a judge's structured edit would DO, said as a sentence about the questionnaire.
 *
 * The design-op sibling of `describeScopeProposedEdit` and `describePolicyProposedEdit`, and the
 * last of the three panels to get one. Its absence showed: the Questionnaire Pack's evaluation
 * appendix carried the scope and policy panels' `proposedEditSummary` and nothing equivalent for
 * the design panel, so a reader of the pack saw a drafted question's *prose* description while the
 * console showed the drafted prompt, its answer type and the section it would land in.
 *
 * ## Declarative, never imperative
 *
 * These used to be imperative fragments — "Rewrite the question prompt", "Delete this question" —
 * printed under an eyebrow reading "Edit". In that position an imperative reads as an instruction
 * *to the reader*: the admin sees "Rewrite the question prompt" above two buttons and reasonably
 * asks whether they are being told to go and rewrite something themselves, or whether a click will
 * do it. Every one is now declarative and names its subject, so it can only be read as a
 * description of the consequence.
 *
 * The same sentences serve a button in the console and a paragraph in a document, and that is the
 * point of the module: a pack that described an op differently from the button that performs it
 * would be wrong in the place it matters most.
 *
 * Pure — an op in, a sentence out. No React, no Prisma, no fetching.
 */

import { QUESTION_TYPE_LABELS } from '@/lib/app/questionnaire/types';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation/types';
import type { FindingDestinationView } from '@/lib/app/questionnaire/views';

/**
 * Where a drafted question will land, as a sentence a reviewer can act on.
 *
 * Said in words rather than left to a chip, because the fact worth conveying is not the section's
 * name but whether anyone *chose* it. A judge that named a section made a judgement the reviewer
 * can weigh; a default is the apply engine appending to whatever section happens to be last, which
 * the reviewer should probably override and could not previously even see.
 *
 * `terminal` matters and is not cosmetic. A pack prints findings that were applied or declined long
 * ago, so the same care the card takes applies there: see the `null` cases below, which exist
 * because the honest answer after the fact is silence, not a guess in the past tense.
 */
export function destinationSentence(
  dest: FindingDestinationView,
  terminal: boolean
): string | null {
  if (dest.origin === 'none') {
    return terminal
      ? null
      : 'This questionnaire has no sections, so there is nowhere to put it yet. Add a section first.';
  }
  const where =
    dest.sectionPosition === null
      ? `“${dest.sectionTitle}”`
      : `“${dest.sectionTitle}” (section ${dest.sectionPosition})`;
  if (dest.origin === 'chosen') {
    // Past tense once the finding is terminal. `chosen` comes from the op's own `sectionKey`,
    // which is the title apply resolved against, so this stays true after the fact.
    return terminal ? `Went into ${where}.` : `Goes into ${where}.`;
  }
  // A default is re-derived against the structure as it is NOW, so on a terminal finding it would
  // name whichever section is last today rather than where the question actually went, in a tense
  // that promises a future that already happened. Nothing recorded the real answer, so say nothing.
  return terminal ? null : `No section was suggested, so it would go at the end of ${where}.`;
}

/**
 * What applying this op will do to the questionnaire, as a sentence about the questionnaire.
 *
 * `destination` is only read for an `add_question` and may be `null` everywhere, including there —
 * a run that predates destination resolution simply names no section.
 */
export function describeProposedEdit(
  op: ProposedEdit,
  destination: FindingDestinationView | null
): string {
  switch (op.op) {
    case 'replace_prompt':
      return "Replaces this question's wording with the suggested version.";
    case 'split_question':
      return 'Replaces this question with the first prompt above, and adds the second one straight after it.';
    case 'edit_guidelines':
      return op.guidelines === null
        ? 'Clears the author guidelines on this question.'
        : 'Sets the author guidelines on this question.';
    case 'change_type':
      return `Changes the answer type to ${QUESTION_TYPE_LABELS[op.type]}, and resets that question's type-specific settings.`;
    case 'delete_question':
      return 'Removes this question from the questionnaire.';
    case 'reorder':
      return op.targetSectionKey
        ? `Moves this question into “${op.targetSectionKey}”, at position ${op.ordinal + 1}.`
        : `Moves this question to position ${op.ordinal + 1}.`;
    case 'edit_goal':
      return "Replaces the questionnaire's goal statement.";
    case 'edit_audience':
      return `Updates the audience description (${Object.keys(op.audience).join(', ')}).`;
    case 'add_question': {
      // The section is named here as well as on the draft block above it, and deliberately: in the
      // console this is the sentence directly under the button, and it is the last thing read
      // before a click that writes a question into a section the reviewer never picked.
      const base = `Adds this as a new ${QUESTION_TYPE_LABELS[op.type]} question`;
      if (!destination || destination.origin === 'none') return `${base}.`;
      return destination.origin === 'chosen'
        ? `${base} in “${destination.sectionTitle}”.`
        : `${base} at the end of “${destination.sectionTitle}”.`;
    }
  }
}
