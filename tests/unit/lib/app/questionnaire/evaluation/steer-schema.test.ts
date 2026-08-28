/**
 * Unit test: the steer contract — what the AI leg of batch apply is allowed to change.
 *
 * This module is the safety model for the whole leg, and it is a structural one rather than a
 * prompt-shaped one: the model can only return text for the op it was given, and `mergeSteeredEdit`
 * rebuilds every other field from the judge's original. So what is worth pinning here is not that
 * valid input parses — it is that the things a rewrite must never move (a slot key, an answer type,
 * a section, the op itself) cannot move even when the model asks for it.
 */

import { describe, it, expect } from 'vitest';

import {
  isSteerableOp,
  mergeSteeredEdit,
  steeredEditSchema,
  validateSteerResult,
  STEERABLE_OPS,
} from '@/lib/app/questionnaire/evaluation/steer-schema';
import { PROPOSED_EDIT_OPS, type ProposedEdit } from '@/lib/app/questionnaire/evaluation';

describe('isSteerableOp', () => {
  it('accepts every op that carries wording and refuses every op that does not', () => {
    // The three refused ops are the reason `steer_unsupported` exists: a deletion, a move and a
    // type change have no prose for an instruction to shape, so a steer on one is reported rather
    // than applied with the reviewer's sentence discarded.
    const wordless = PROPOSED_EDIT_OPS.filter(
      (op) => !(STEERABLE_OPS as readonly string[]).includes(op)
    );
    expect(wordless).toEqual(['change_type', 'delete_question', 'reorder']);

    expect(isSteerableOp({ op: 'replace_prompt', prompt: 'x' })).toBe(true);
    expect(isSteerableOp({ op: 'delete_question' })).toBe(false);
    expect(isSteerableOp({ op: 'reorder', ordinal: 2 })).toBe(false);
    expect(isSteerableOp({ op: 'change_type', type: 'likert' })).toBe(false);
  });
});

describe('steeredEditSchema', () => {
  it('has no field for a key, a type, a section or an ordinal', () => {
    // The first half of the safety model: the model is never offered the fields that decide a
    // question's identity or placement, so it has no way to move one by accident.
    const parsed = steeredEditSchema.safeParse({
      op: 'add_question',
      prompt: 'How long have you been in the role?',
      key: 'sneaky_key',
      type: 'likert',
      sectionKey: 'Elsewhere',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      op: 'add_question',
      prompt: 'How long have you been in the role?',
    });
  });

  it('refuses an op it was never given', () => {
    expect(steeredEditSchema.safeParse({ op: 'delete_question' }).success).toBe(false);
  });
});

describe('validateSteerResult', () => {
  it('reads a full result, treating a missing unhonoured as nothing left over', () => {
    const result = validateSteerResult({
      revised: { op: 'replace_prompt', prompt: 'Shorter?' },
      note: 'Cut it to ten words.',
    });
    expect(result).toMatchObject({ note: 'Cut it to ten words.' });
    expect(result?.unhonoured ?? null).toBeNull();
  });

  it('returns null on a reply that is not a result, so the caller retries', () => {
    expect(validateSteerResult({ revised: { op: 'replace_prompt', prompt: 'x' } })).toBeNull();
    expect(validateSteerResult('sure, here you go')).toBeNull();
  });
});

describe('mergeSteeredEdit', () => {
  it('refuses a revision that changes the operation', () => {
    // The one outright refusal. An op-kind switch is the model overruling the reviewer's own
    // decision — they accepted a reword, and a delete applied in its place is a change nobody
    // agreed to.
    expect(
      mergeSteeredEdit(
        { op: 'replace_prompt', prompt: 'Judge wording' },
        {
          op: 'edit_goal',
          goal: 'Something else entirely',
        }
      )
    ).toBeNull();
  });

  it('takes the wording from the revision', () => {
    expect(
      mergeSteeredEdit(
        { op: 'replace_prompt', prompt: 'Judge wording' },
        {
          op: 'replace_prompt',
          prompt: 'Reviewer wording',
        }
      )
    ).toEqual({ op: 'replace_prompt', prompt: 'Reviewer wording' });
  });

  it('keeps the judge’s second key on a split, and rewrites only the two prompts', () => {
    // `secondKey` addresses the slot the split creates. The reviewer accepted a split that makes
    // *that* question; a rewrite of the wording has no business renaming it.
    const original: ProposedEdit = {
      op: 'split_question',
      prompt: 'A?',
      secondPrompt: 'B?',
      secondKey: 'support_satisfaction',
    };
    expect(
      mergeSteeredEdit(original, {
        op: 'split_question',
        prompt: 'A, plainly?',
        secondPrompt: 'B, plainly?',
      })
    ).toEqual({
      op: 'split_question',
      prompt: 'A, plainly?',
      secondPrompt: 'B, plainly?',
      secondKey: 'support_satisfaction',
    });
  });

  it('keeps an added question’s type, key and section while rewording it', () => {
    const original: ProposedEdit = {
      op: 'add_question',
      prompt: 'Judge wording',
      type: 'likert',
      key: 'morale_now',
      sectionKey: 'About you',
      guidelines: 'Probe for a reason.',
    };
    expect(mergeSteeredEdit(original, { op: 'add_question', prompt: 'Reviewer wording' })).toEqual({
      ...original,
      prompt: 'Reviewer wording',
    });
  });

  it('rewrites an added question’s guidelines when the revision supplies them', () => {
    const original: ProposedEdit = {
      op: 'add_question',
      prompt: 'Judge wording',
      type: 'free_text',
      guidelines: 'Old note.',
    };
    expect(
      mergeSteeredEdit(original, {
        op: 'add_question',
        prompt: 'Reviewer wording',
        guidelines: 'New note.',
      })
    ).toEqual({ ...original, prompt: 'Reviewer wording', guidelines: 'New note.' });
  });

  it('clears an added question’s guidelines when the revision says null', () => {
    // Three-valued, and the distinction is the point: null CLEARS (the reviewer asked to drop the
    // guidance and the prompt offers exactly that), while undefined means the model did not speak
    // to them. Reading null as "did not speak to them" is the half-honoured-silently case.
    const original: ProposedEdit = {
      op: 'add_question',
      prompt: 'Judge wording',
      type: 'free_text',
      guidelines: 'Old note.',
    };
    const cleared = mergeSteeredEdit(original, {
      op: 'add_question',
      prompt: 'Reviewer wording',
      guidelines: null,
    });
    expect(cleared).toMatchObject({ op: 'add_question', prompt: 'Reviewer wording' });
    expect(cleared && 'guidelines' in cleared ? cleared.guidelines : undefined).toBeUndefined();
  });

  it('leaves the judge’s guidelines alone when the revision does not mention them', () => {
    const original: ProposedEdit = {
      op: 'add_question',
      prompt: 'Judge wording',
      type: 'free_text',
      guidelines: 'Old note.',
    };
    expect(mergeSteeredEdit(original, { op: 'add_question', prompt: 'Reviewer wording' })).toEqual({
      ...original,
      prompt: 'Reviewer wording',
    });
  });

  it('restates the goal and the audience from the revision', () => {
    expect(
      mergeSteeredEdit({ op: 'edit_goal', goal: 'Old' }, { op: 'edit_goal', goal: 'New' })
    ).toEqual({ op: 'edit_goal', goal: 'New' });
    expect(
      mergeSteeredEdit(
        { op: 'edit_audience', audience: { role: 'Managers' } },
        { op: 'edit_audience', audience: { role: 'Team leads', expertiseLevel: 'novice' } }
      )
    ).toEqual({
      op: 'edit_audience',
      audience: { role: 'Team leads', expertiseLevel: 'novice' },
    });
  });

  it('lets a revision clear guidelines, because clearing them is a change a judge can propose', () => {
    expect(
      mergeSteeredEdit(
        { op: 'edit_guidelines', guidelines: 'Old note' },
        {
          op: 'edit_guidelines',
          guidelines: null,
        }
      )
    ).toEqual({ op: 'edit_guidelines', guidelines: null });
  });
});
