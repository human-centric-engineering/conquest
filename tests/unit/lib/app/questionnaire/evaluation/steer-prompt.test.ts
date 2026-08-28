/**
 * Unit tests for the steer prompt builder — the AI leg of design-evaluation batch apply.
 *
 * Pure, IO-free string assembly. The Zod schema (`steer-schema.ts`) is the real safety net, so
 * these guard the prose contract that schema cannot express: that the model is shown the change it
 * must keep, the question as it stands, and the judge's reason for the change; that the reviewer's
 * instruction arrives fenced as their words rather than folded into the rules; and that the op
 * description offers only the fields a rewrite may touch.
 */

import { describe, it, expect } from 'vitest';

import { getTextContent } from '@/lib/orchestration/llm/types';
import {
  buildSteerPrompt,
  buildSteerRetryMessage,
  STEER_PROMPT_VERSION,
  type SteerPromptInput,
} from '@/lib/app/questionnaire/evaluation/steer-prompt';

function input(over: Partial<SteerPromptInput> = {}): SteerPromptInput {
  return {
    instruction: 'Keep it under 15 words.',
    op: { op: 'replace_prompt', prompt: 'How would you describe morale in your team right now?' },
    proposedChange: 'Reword it so it asks about one thing.',
    rationale: 'It is double-barrelled.',
    dimensionLabel: 'Clarity Judge',
    question: {
      key: 'team_morale',
      prompt: 'How is morale, and is support adequate?',
      type: 'free_text',
      required: true,
    },
    goal: 'Understand how the team is doing.',
    audience: { role: 'Team leads', expertiseLevel: 'intermediate' },
    ...over,
  };
}

/** The user message — where everything about this one change lives. */
function userContent(over: Partial<SteerPromptInput> = {}): string {
  const messages = buildSteerPrompt(input(over));
  return getTextContent(messages[1].content);
}

describe('buildSteerPrompt', () => {
  it('is a two-message prompt: the rules, then this one change', () => {
    const messages = buildSteerPrompt(input());
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('tells the model to keep the change it was given', () => {
    // The rule the whole leg rests on. The schema makes an op switch unrepresentable; the prose
    // says so too, because a model working inside a constraint writes better text than one
    // fighting it.
    expect(getTextContent(buildSteerPrompt(input())[0].content)).toContain('KEEP THE CHANGE');
  });

  it('shows the question as it stands now, not only the proposed replacement', () => {
    // A rewrite that cannot see the current wording is guessing at what it is changing.
    const content = userContent();
    expect(content).toContain('How is morale, and is support adequate?');
    expect(content).toContain('How would you describe morale in your team right now?');
  });

  it('carries the judge’s reason, so a rewrite does not undo the fix it is making', () => {
    expect(userContent()).toContain('It is double-barrelled.');
    expect(userContent()).toContain('Clarity Judge');
  });

  it('fences the reviewer’s instruction as their words about wording', () => {
    // The instruction is admin-authored and meant to be followed, but it is quoted as a note about
    // one change rather than spliced into the system rules — an instruction that tries to redirect
    // the task has no way to express itself in the output schema.
    const content = userContent();
    expect(content).toContain('"""\nKeep it under 15 words.\n"""');
    expect(content).toContain('their words, about wording only');
  });

  it('offers only the fields a rewrite may touch, for each steerable op', () => {
    // No key, no type, no section, no ordinal: the model is not shown the fields that decide a
    // question's identity or placement, so it cannot ask to move one.
    const split = userContent({
      op: { op: 'split_question', prompt: 'A?', secondPrompt: 'B?', secondKey: 'second_slot' },
    });
    expect(split).toContain('"secondPrompt"');
    expect(split).not.toContain('second_slot');

    const added = userContent({
      op: { op: 'add_question', prompt: 'New?', type: 'likert', key: 'new_slot' },
      question: null,
    });
    expect(added).toContain('are already decided and are not yours to change');
    expect(added).not.toContain('new_slot');
  });

  it('describes each steerable op in its own terms', () => {
    // Every op the batch can steer has to arrive with its own return shape, or the model is
    // guessing at which fields it may fill in.
    expect(
      userContent({ op: { op: 'edit_guidelines', guidelines: 'Probe for a reason.' } })
    ).toContain('Probe for a reason.');
    expect(
      userContent({
        op: { op: 'edit_audience', audience: { role: 'Team leads' } },
        question: null,
      })
    ).toContain('"audience"');
  });

  it('names an absent value rather than printing "undefined" at the model', () => {
    expect(userContent({ op: { op: 'edit_guidelines', guidelines: null } })).toContain(
      '(clear them)'
    );
    expect(
      userContent({ op: { op: 'add_question', prompt: 'New?', type: 'likert' }, question: null })
    ).toContain('(none)');
    expect(
      userContent({ question: { key: 'q', prompt: 'P?', type: 'free_text', required: true } })
    ).toContain('guidelines: (none)');
  });

  it('degrades to a plain line for a wordless op instead of throwing', () => {
    // The batch never steers one — `isSteerableOp` stops it — but a builder that throws on an
    // input it should never see turns a caller's bug into a crash rather than a report.
    expect(userContent({ op: { op: 'delete_question' } })).toContain('no wording to change');
  });

  it('says plainly when the change is not about a single question', () => {
    expect(
      userContent({ op: { op: 'edit_goal', goal: 'Sharper goal' }, question: null })
    ).toContain('about the questionnaire as a whole');
  });

  it('names an unstated goal and audience rather than leaving a blank line', () => {
    const content = userContent({ goal: null, audience: null });
    expect(content).toContain('Questionnaire goal: (not stated)');
    expect(content).toContain('Audience: (not stated)');
  });
});

describe('buildSteerRetryMessage', () => {
  it('re-states the two constraints a failed reply most likely broke', () => {
    const retry = buildSteerRetryMessage();
    expect(retry).toContain('Do not change the op');
    expect(retry).toContain('no prose outside the JSON');
  });
});

describe('STEER_PROMPT_VERSION', () => {
  it('is stamped on every recorded run, so a rewrite is traceable to the rules that produced it', () => {
    expect(STEER_PROMPT_VERSION).toBe('evaluation-steer/v1');
  });
});
