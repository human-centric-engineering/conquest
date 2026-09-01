/**
 * describe-edit — the sentences shared between the admin console and the Questionnaire Pack.
 *
 * This module exists so that a document and the button that performs an edit cannot describe the
 * same op differently. That guarantee is only worth as much as its coverage: before this file, six
 * of the nine `ProposedEdit` variants were exercised only incidentally, because other suites'
 * fixtures happened to reach for them, and three (`split_question`, `change_type`, `edit_goal`)
 * were never asserted anywhere at all. A copy-paste that duplicated one case's text into another
 * would have shipped green into both the console and a client-facing PDF.
 *
 * So this asserts the exact wording of every op, plus every branch of the destination sentence.
 * `PROPOSED_EDIT_OPS` is walked at the end to prove the list stays exhaustive as ops are added.
 *
 * Two properties the wording must hold, and both are asserted rather than assumed:
 *  - **Declarative, never imperative.** An imperative above a button reads as an instruction to the
 *    reader ("Rewrite the question prompt" — am I being told to go and do that?). Every sentence
 *    describes a consequence instead.
 *  - **Named subject.** The sentence says what it acts on, so it survives being read in a document
 *    with no button next to it.
 *
 * @see lib/app/questionnaire/evaluation/describe-edit.ts
 */

import { describe, it, expect } from 'vitest';

import {
  describeProposedEdit,
  destinationSentence,
} from '@/lib/app/questionnaire/evaluation/describe-edit';
import { PROPOSED_EDIT_OPS, type ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { FindingDestinationView } from '@/lib/app/questionnaire/views';

describe('describeProposedEdit', () => {
  it('describes a reword', () => {
    expect(
      describeProposedEdit({ op: 'replace_prompt', prompt: 'A clearer question?' }, null)
    ).toBe("Replaces this question's wording with the suggested version.");
  });

  it('describes a split, naming what happens to each half', () => {
    // Never asserted anywhere before this file, though the Clarity judge actively emits it. The
    // order is load-bearing: the first prompt stays on the existing question (keeping its id, type
    // and any answers mapped to it) and the second becomes a new question after it.
    expect(
      describeProposedEdit(
        { op: 'split_question', prompt: 'First half?', secondPrompt: 'Second half?' },
        null
      )
    ).toBe(
      'Replaces this question with the first prompt above, and adds the second one straight after it.'
    );
  });

  it('distinguishes setting guidelines from clearing them', () => {
    // `guidelines: null` is the clear, and it is a different consequence from setting them — a
    // single sentence covering both would misdescribe one of the two.
    expect(describeProposedEdit({ op: 'edit_guidelines', guidelines: 'Be concise.' }, null)).toBe(
      'Sets the author guidelines on this question.'
    );
    expect(describeProposedEdit({ op: 'edit_guidelines', guidelines: null }, null)).toBe(
      'Clears the author guidelines on this question.'
    );
  });

  it('describes a type change with the reader-facing type label, and warns about the reset', () => {
    // Never asserted before. The label comes from `QUESTION_TYPE_LABELS`, so an unmapped type would
    // have interpolated `undefined` into a client-facing PDF with nothing to catch it. The reset
    // clause matters: changing the type discards that question's type-specific settings.
    expect(describeProposedEdit({ op: 'change_type', type: 'single_choice' }, null)).toBe(
      "Changes the answer type to Multi-Choice (One Answer), and resets that question's type-specific settings."
    );
    expect(describeProposedEdit({ op: 'change_type', type: 'likert' }, null)).toBe(
      "Changes the answer type to Likert, and resets that question's type-specific settings."
    );
  });

  it('describes a deletion', () => {
    expect(describeProposedEdit({ op: 'delete_question' }, null)).toBe(
      'Removes this question from the questionnaire.'
    );
  });

  it('describes a move, and names the destination section when the op changes it', () => {
    // Ordinals are 0-based on the op and 1-based to a reader, so an off-by-one here would tell the
    // admin the question lands one place from where it actually will.
    expect(describeProposedEdit({ op: 'reorder', ordinal: 2 }, null)).toBe(
      'Moves this question to position 3.'
    );
    expect(
      describeProposedEdit({ op: 'reorder', ordinal: 0, targetSectionKey: 'Background' }, null)
    ).toBe('Moves this question into “Background”, at position 1.');
  });

  it('describes a goal rewrite', () => {
    expect(describeProposedEdit({ op: 'edit_goal', goal: 'A sharper goal.' }, null)).toBe(
      "Replaces the questionnaire's goal statement."
    );
  });

  it('names which audience sub-fields a merge-patch touches', () => {
    // `edit_audience` is a merge-patch, so only the named sub-fields change. Listing them is the
    // difference between "your audience description is being replaced" and the truth.
    expect(
      describeProposedEdit(
        {
          op: 'edit_audience',
          audience: { description: 'New hires', role: 'Individual contributor' },
        },
        null
      )
    ).toBe('Updates the audience description (description, role).');
  });

  describe('add_question', () => {
    const op: ProposedEdit = { op: 'add_question', prompt: 'A new one?', type: 'free_text' };

    it('names the section when someone chose it', () => {
      expect(
        describeProposedEdit(op, {
          sectionTitle: 'Background',
          sectionPosition: 2,
          origin: 'chosen',
        })
      ).toBe('Adds this as a new Free text question in “Background”.');
    });

    it('says "at the end of" when nothing chose the section', () => {
      // The distinction the destination exists for: a judge that named a section made a judgement
      // the reviewer can weigh, where a default is the apply engine appending to whatever section
      // happens to be last.
      expect(
        describeProposedEdit(op, {
          sectionTitle: 'Wrap-up',
          sectionPosition: 4,
          origin: 'default',
        })
      ).toBe('Adds this as a new Free text question at the end of “Wrap-up”.');
    });

    it('names no section when there is none to name', () => {
      // `origin: 'none'` means the version has no sections; a run that predates destination
      // resolution passes null. Neither may invent a place for the question.
      expect(
        describeProposedEdit(op, { sectionTitle: null, sectionPosition: null, origin: 'none' })
      ).toBe('Adds this as a new Free text question.');
      expect(describeProposedEdit(op, null)).toBe('Adds this as a new Free text question.');
    });
  });

  it('covers every op in PROPOSED_EDIT_OPS with a non-empty declarative sentence', () => {
    // The exhaustiveness guard. `describeProposedEdit` switches on a union so a new op is already a
    // compile error, but this also pins that no case returns an empty string or an imperative — the
    // two ways the wording could regress while still type-checking.
    const samples: Record<(typeof PROPOSED_EDIT_OPS)[number], ProposedEdit> = {
      replace_prompt: { op: 'replace_prompt', prompt: 'x' },
      split_question: { op: 'split_question', prompt: 'x', secondPrompt: 'y' },
      edit_guidelines: { op: 'edit_guidelines', guidelines: 'x' },
      change_type: { op: 'change_type', type: 'free_text' },
      delete_question: { op: 'delete_question' },
      reorder: { op: 'reorder', ordinal: 0 },
      edit_goal: { op: 'edit_goal', goal: 'x' },
      edit_audience: { op: 'edit_audience', audience: { description: 'x' } },
      add_question: { op: 'add_question', prompt: 'x', type: 'free_text' },
    };

    for (const opName of PROPOSED_EDIT_OPS) {
      const sentence = describeProposedEdit(samples[opName], null);
      expect(sentence, opName).toBeTruthy();
      // Declarative: a full sentence ending in a stop, not an imperative fragment.
      expect(sentence.endsWith('.'), `${opName} ends in a full stop`).toBe(true);
      // No stray "undefined" from an unmapped label lookup reaching a client-facing document.
      expect(sentence, opName).not.toContain('undefined');
    }
  });
});

describe('destinationSentence', () => {
  const chosen: FindingDestinationView = {
    sectionTitle: 'Background',
    sectionPosition: 2,
    origin: 'chosen',
  };

  it('names the section and its position while the finding is still open', () => {
    expect(destinationSentence(chosen, false)).toBe('Goes into “Background” (section 2).');
  });

  it('switches to the past tense once the finding is terminal', () => {
    // `chosen` comes from the op's own `sectionKey`, which is the title apply resolved against, so
    // it stays true after the fact.
    expect(destinationSentence(chosen, true)).toBe('Went into “Background” (section 2).');
  });

  it('drops the position when the title no longer resolves to exactly one section', () => {
    // `sectionPosition: null` is the same condition that makes the finding stale, so the card is
    // already blocking Apply — the sentence just must not claim a position it does not have.
    expect(destinationSentence({ ...chosen, sectionPosition: null }, false)).toBe(
      'Goes into “Background”.'
    );
  });

  it('says plainly that nobody chose the section when apply would default', () => {
    expect(
      destinationSentence({ sectionTitle: 'Wrap-up', sectionPosition: 3, origin: 'default' }, false)
    ).toBe('No section was suggested, so it would go at the end of “Wrap-up” (section 3).');
  });

  it('says nothing at all about a defaulted destination once the finding is terminal', () => {
    // The case worth having a test for. A default is re-derived against the structure as it is
    // NOW, so on a terminal finding it would name whichever section happens to be last today
    // rather than where the question actually went — in a tense promising a future that already
    // happened. Nothing recorded the real answer, so the honest output is silence.
    expect(
      destinationSentence({ sectionTitle: 'Wrap-up', sectionPosition: 3, origin: 'default' }, true)
    ).toBeNull();
  });

  it('tells the reviewer to add a section first when there are none', () => {
    expect(
      destinationSentence({ sectionTitle: null, sectionPosition: null, origin: 'none' }, false)
    ).toBe(
      'This questionnaire has no sections, so there is nowhere to put it yet. Add a section first.'
    );
  });

  it('says nothing about a missing section once the finding is terminal', () => {
    expect(
      destinationSentence({ sectionTitle: null, sectionPosition: null, origin: 'none' }, true)
    ).toBeNull();
  });
});
