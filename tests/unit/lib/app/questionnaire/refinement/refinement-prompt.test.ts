import { describe, expect, it } from 'vitest';

import {
  buildRefinementPrompt,
  buildRefinementRetryMessage,
} from '@/lib/app/questionnaire/refinement/refinement-prompt';

import {
  choiceSlot,
  ctx,
  existing,
  slot,
} from '@/tests/unit/lib/app/questionnaire/refinement/_fixtures';

describe('buildRefinementPrompt', () => {
  it('emits a system rules message and a user message', () => {
    const messages = buildRefinementPrompt(
      ctx({ existingAnswers: [existing({ slotKey: 'a' })], userMessage: 'actually it was 5' })
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('lists the three actions in the system rules', () => {
    const [system] = buildRefinementPrompt(ctx({ existingAnswers: [existing({ slotKey: 'a' })] }));
    expect(system?.content).toMatch(/refine/);
    expect(system?.content).toMatch(/overwrite/);
    expect(system?.content).toMatch(/leave/);
  });

  it('frames the rules and the new context in named XML sections', () => {
    const [system, user] = buildRefinementPrompt(
      ctx({ existingAnswers: [existing({ slotKey: 'a' })], userMessage: 'I misspoke' })
    );
    expect(system?.content).toContain('<refinement_rules>');
    const u = typeof user?.content === 'string' ? user.content : '';
    expect(u).toContain('<existing_answers>');
    expect(u).toContain('<new_message>');
  });

  it('renders each existing answer with its current value and provenance', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'age', value: 30, provenance: 'inferred' })],
        slots: [slot({ key: 'age', type: 'numeric', prompt: 'How old are you?' })],
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/key: age/);
    expect(user).toMatch(/How old are you\?/);
    expect(user).toMatch(/current_answer: 30/);
    expect(user).toMatch(/current_provenance: inferred/);
  });

  it('includes the triggering contradiction and its suggested probe when present', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'a' }), existing({ slotKey: 'b' })],
        triggeringContradiction: {
          slotKeys: ['a', 'b'],
          explanation: 'no children vs a daughter',
          suggestedProbe: 'Do you have children?',
        },
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/contradiction was flagged/i);
    expect(user).toMatch(/no children vs a daughter/);
    expect(user).toMatch(/Do you have children\?/);
  });

  it('works when driven by a new message alone (no contradiction)', () => {
    const messages = buildRefinementPrompt(
      ctx({ existingAnswers: [existing({ slotKey: 'a' })], userMessage: 'I misspoke earlier' })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/I misspoke earlier/);
    expect(user).not.toMatch(/contradiction was flagged/i);
  });

  it('renders choice options for a choice slot', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'color', value: 'red' })],
        slots: [choiceSlot('color', 'single_choice', 'red', 'green')],
      })
    );
    expect(messages[1]?.content).toMatch(/options: red \(RED\), green \(GREEN\)/);
  });

  it('renders a likert slot’s scale and guidelines', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'agree', value: 4 })],
        slots: [
          slot({
            key: 'agree',
            type: 'likert',
            typeConfig: { min: 1, max: 5 },
            guidelines: 'Higher = stronger agreement',
          }),
        ],
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/scale: 1–5/);
    expect(user).toMatch(/guidelines: Higher = stronger agreement/);
  });

  it('renders array, object, and empty values without tripping', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [
          existing({ slotKey: 'langs', value: ['ts', 'go'] }),
          existing({ slotKey: 'meta', value: { a: 1 } }),
          // Inline (not via the fixture, which coerces null → a default) so the
          // `(none)` render path is genuinely exercised.
          { slotKey: 'note', value: null, provenance: 'direct' },
        ],
        slots: [
          // Raw choices WITHOUT labels — exercises the no-label option branch.
          slot({
            key: 'langs',
            type: 'multi_choice',
            typeConfig: { choices: [{ value: 'ts' }, { value: 'go' }] },
          }),
          slot({ key: 'meta', type: 'free_text' }),
          slot({ key: 'note', type: 'free_text' }),
        ],
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/current_answer: ts, go/);
    expect(user).toMatch(/current_answer: \{"a":1\}/);
    expect(user).toMatch(/current_answer: \(none\)/);
    expect(user).toMatch(/options: ts, go/); // no "(LABEL)" suffix
  });

  it('includes recent conversation lines when supplied', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'a' })],
        recentMessages: ['agent: are you sure?', 'user: yes'],
      })
    );
    expect(messages[1]?.content).toMatch(/Recent conversation:/);
    expect(messages[1]?.content).toMatch(/user: yes/);
  });

  it('renders a triggering contradiction that carries no suggested probe', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'a' }), existing({ slotKey: 'b' })],
        triggeringContradiction: { slotKeys: ['a', 'b'], explanation: 'a vs b' },
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/a vs b/);
    expect(user).not.toMatch(/Suggested follow-up/);
  });

  it('skips an answer whose slot key has no matching definition', () => {
    const messages = buildRefinementPrompt(
      ctx({
        existingAnswers: [existing({ slotKey: 'known' }), existing({ slotKey: 'orphan' })],
        slots: [slot({ key: 'known' })], // no slot for "orphan"
      })
    );
    const user = messages[1]?.content ?? '';
    expect(user).toMatch(/key: known/);
    expect(user).not.toMatch(/key: orphan/);
  });
});

describe('buildRefinementRetryMessage', () => {
  it('names the invalid field paths when provided', () => {
    const message = buildRefinementRetryMessage([
      'refinements.0.slotKey',
      'refinements.0.confidence',
    ]);
    expect(message).toMatch(/refinements\.0\.slotKey/);
    expect(message).toMatch(/refinements\.0\.confidence/);
  });

  it('falls back to a generic message with no paths', () => {
    const message = buildRefinementRetryMessage([]);
    expect(message).toMatch(/not valid JSON/);
  });
});
