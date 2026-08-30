/**
 * The interviewer prompt's SECTION ORDER is a behaviour contract (F20.4).
 *
 * `buildStreamingQuestionPrompt` assembles its system prompt from XML-tagged sections whose order
 * encodes a precedence hierarchy — the prompt convention is **later wins**, and three separate
 * comments in that file rely on it:
 *
 *   - `<interviewer_strategy>` sits after `<rules>`/`<this_turn>` so a configured approach governs
 *     the default questioning guidance.
 *   - `<question_fidelity>` sits after both, because at `close`/`must_ask` it directly contradicts
 *     their standing "ask openly, never read out the options" guidance.
 *   - `<house_rules>` sits after `<tone>` (a client's policy outranks the admin's voice dials) but
 *     BEFORE `<output_format>`/`<message_shape>`, which must keep governing the reply contract no
 *     matter what a rule asks for.
 *
 * None of that was executable until this file. It matters now because P20 Phase 4 established a
 * standing temptation to reorder these sections: the stable, cacheable content (`<output_format>`,
 * `<message_shape>`, `<house_rules>`) is deliberately LAST, which is exactly where prompt caching
 * cannot use it. Hoisting it would cross OpenAI's 1,024-token cacheable-prefix minimum — and would
 * silently invert the hierarchy, letting a house rule override the reply contract. This test makes
 * that trade explicit instead of a silent regression.
 *
 * See `.context/app/planning/features/f20.4.md` for the measurement that says the trade is not
 * worth taking.
 */

import { describe, it, expect } from 'vitest';

import { buildStreamingQuestionPrompt } from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { DEFAULT_INTERVIEWER_STRATEGY } from '@/lib/app/questionnaire/types';
import { getTextContent } from '@/lib/orchestration/llm/types';

/** Every section tag the assembled system prompt can contain, in the order it must contain them. */
const EXPECTED_ORDER = [
  'role',
  'rules',
  'this_turn',
  'interviewer_strategy',
  'question_fidelity',
  'profile_capture',
  'context',
  'briefing',
  'glossary',
  'peer_context',
  'tone',
  'house_rules',
  'output_format',
  'message_shape',
] as const;

/** The system message's text. `LlmMessage.content` may be content parts, so never `String(...)` it. */
function systemText(messages: ReturnType<typeof buildStreamingQuestionPrompt>): string {
  const system = messages.find((m) => m.role === 'system');
  return system ? getTextContent(system.content) : '';
}

/** The opening `<tag>` names in the order they appear, ignoring closing tags. */
function sectionOrder(prompt: string): string[] {
  return [...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((m) => m[1]).filter((t) => t !== undefined);
}

/**
 * An input that populates EVERY optional section, so the order assertion sees the full prompt
 * rather than whichever subset a default turn happens to render.
 */
function maximalInput() {
  return {
    prompt: 'How well do your teams share information?',
    type: 'free_text' as const,
    guidelines: 'Look for concrete examples.',
    goal: 'Understand internal collaboration.',
    audience: { role: 'Operations lead', expertiseLevel: 'expert' as const },
    recentMessages: ['Interviewer: Hello.', 'Respondent: Hi.'],
    priorAnswers: ['Team size: about forty'],
    briefing: ['Headcount: 40 across three offices'],
    glossary: ['- integration: how closely teams share systems'],
    peerContext: ['Several mentioned tooling gaps'],
    lastUserMessage: 'We are about forty people.',
    isReask: false,
    isOpening: false,
    questionsAsked: 4,
    houseRules: 'Never use humour.',
    profileCapture: 'Also find out which region they work in.',
    sensitivityLevel: 'medium' as const,
    sensitivityNotes: ['mentioned a difficult period at work'],
    fidelity: 'balanced' as const,
    coverage: 0.4,
    // On by default in production, so the maximal prompt must include it.
    interviewerStrategy: DEFAULT_INTERVIEWER_STRATEGY,
  };
}

describe('buildStreamingQuestionPrompt — section order is a precedence contract', () => {
  it('emits every section in the documented precedence order', () => {
    const order = sectionOrder(systemText(buildStreamingQuestionPrompt(maximalInput())));

    // Only sections this input actually populates are present; the ones that are must be in order.
    expect(order).toEqual(EXPECTED_ORDER.filter((tag) => order.includes(tag)));
  });

  it('keeps the reply contract LAST, so no house rule can override it', () => {
    // The inversion with a concrete failure mode: a client house rule saying "answer in bullet
    // points" must not beat `<output_format>`'s "conversational prose only", because the chat
    // surface renders the reply as prose.
    const text = systemText(buildStreamingQuestionPrompt(maximalInput()));

    expect(text.indexOf('<house_rules>')).toBeGreaterThan(-1);
    expect(text.indexOf('<house_rules>')).toBeLessThan(text.indexOf('<output_format>'));
    expect(text.indexOf('<output_format>')).toBeLessThan(text.indexOf('<message_shape>'));
  });

  it('keeps house rules after tone, so a client policy outranks the admin voice dials', () => {
    // "Never use humour" must win over a humour dial set high.
    const text = systemText(buildStreamingQuestionPrompt(maximalInput()));

    expect(text.indexOf('<tone>')).toBeGreaterThan(-1);
    expect(text.indexOf('<tone>')).toBeLessThan(text.indexOf('<house_rules>'));
  });

  it('keeps fidelity and strategy after the standing rules they are allowed to contradict', () => {
    const text = systemText(
      buildStreamingQuestionPrompt({ ...maximalInput(), fidelity: 'must_ask' })
    );

    expect(text.indexOf('<interviewer_strategy>')).toBeGreaterThan(-1);
    expect(text.indexOf('<question_fidelity>')).toBeGreaterThan(-1);
    expect(text.indexOf('<rules>')).toBeLessThan(text.indexOf('<interviewer_strategy>'));
    expect(text.indexOf('<this_turn>')).toBeLessThan(text.indexOf('<question_fidelity>'));
    expect(text.indexOf('<interviewer_strategy>')).toBeLessThan(
      text.indexOf('<question_fidelity>')
    );
  });

  it('omits an unconfigured section entirely rather than emitting an empty one', () => {
    // The cardinal rule of the section helpers: absent input costs nothing. An empty `<glossary>`
    // would be a header the model has to interpret with no content under it.
    const text = systemText(
      buildStreamingQuestionPrompt({
        prompt: 'How large is the team?',
        type: 'free_text' as const,
        recentMessages: [],
        lastUserMessage: '',
        isReask: false,
        isOpening: true,
        questionsAsked: 0,
      })
    );

    for (const tag of ['glossary', 'briefing', 'peer_context', 'house_rules', 'profile_capture']) {
      expect(text).not.toContain(`<${tag}>`);
    }
    const order = sectionOrder(text);
    expect(order).toEqual(EXPECTED_ORDER.filter((tag) => order.includes(tag)));
  });

  it('puts the volatile per-turn section before the stable reply contract — the cache tension', () => {
    // The fact P20 Phase 4 measured and decided to live with, asserted so the decision is visible
    // rather than folklore: `<this_turn>` changes every turn and sits third, so everything after it
    // is re-processed by the model on every single turn.
    const order = sectionOrder(systemText(buildStreamingQuestionPrompt(maximalInput())));

    expect(order.indexOf('this_turn')).toBeLessThan(order.indexOf('output_format'));
    expect(order.indexOf('this_turn')).toBeLessThan(order.indexOf('message_shape'));
    // Only `role` and `rules` precede it — the entire stable prefix available to a prompt cache.
    expect(order.slice(0, order.indexOf('this_turn'))).toEqual(['role', 'rules']);
  });
});
