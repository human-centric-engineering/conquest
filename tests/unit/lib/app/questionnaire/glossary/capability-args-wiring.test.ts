/**
 * Glossary → capability args wiring — unit tests (P16).
 *
 * THE GAP THIS EXISTS TO CLOSE. `prompt-seams.test.ts` calls each prompt builder directly, so it
 * passes whether or not the glossary ever reaches the builder at run time. It did not: two of the
 * four per-turn capabilities had no `glossary` key in their `argsSchema`, and because
 * `BaseCapability.validate` safe-parses against a NON-STRICT `z.object`, Zod silently stripped the
 * key. The contradiction detector and the answer refiner were shipping completely inert — the
 * detector still raising the same-term-two-senses false positive the feature exists to prevent.
 *
 * These tests assert the contract at the boundary that actually drops data: the Zod schema. If a
 * capability ever loses the key again, this fails; a prompt-builder test cannot.
 *
 * @see lib/app/questionnaire/capabilities/{extract-answer-slots,detect-contradictions,refine-answer}.ts
 */

import { describe, it, expect } from 'vitest';

import { GLOSSARY_MAX_TERMS } from '@/lib/app/questionnaire/glossary/injection';

const GLOSSARY = ['- ego: (1) The constructed self; (2) the Jungian conscious centre.'];

/**
 * Every per-turn capability that `turn-invokers.ts` passes `glossary` to, with a minimal valid
 * args payload. The phraser is absent deliberately: it is a typed function call
 * (`streamQuestionMessage`), not a Zod-validated dispatch, so it cannot lose the key this way.
 */
const CAPABILITIES = [
  {
    name: 'extract-answer-slots',
    load: () => import('@/lib/app/questionnaire/capabilities/extract-answer-slots'),
    className: 'AppExtractAnswerSlotsCapability',
    args: {
      userMessage: 'My ego gets in the way.',
      activeQuestionKey: 'q1',
      candidateSlots: [{ key: 'q1', prompt: 'Describe your ego.', type: 'free_text' }],
    },
  },
  {
    name: 'detect-contradictions',
    load: () => import('@/lib/app/questionnaire/capabilities/detect-contradictions'),
    className: 'AppDetectContradictionsCapability',
    args: {
      slots: [{ key: 'q1', prompt: 'Is your ego healthy?', type: 'free_text', required: false }],
      answers: [{ slotKey: 'q1', value: 'Yes.', confidence: 0.9 }],
      mode: 'flag',
      windowN: 0,
    },
  },
  {
    name: 'refine-answer',
    load: () => import('@/lib/app/questionnaire/capabilities/refine-answer'),
    className: 'AppRefineAnswerCapability',
    args: {
      slots: [{ key: 'q1', prompt: 'Describe your ego.', type: 'free_text', required: false }],
      existingAnswers: [{ slotKey: 'q1', value: 'It gets in the way.', provenance: 'direct' }],
      userMessage: 'I meant something else by ego.',
    },
  },
] as const;

/** Reach the capability's protected Zod schema (the thing that silently drops unknown keys). */
async function schemaOf(entry: (typeof CAPABILITIES)[number]) {
  const mod = (await entry.load()) as Record<string, new () => unknown>;
  const instance = new mod[entry.className]() as { schema: { parse: (v: unknown) => unknown } };
  // `schema` is `protected`; reading it is the point of this test.
  return (instance as unknown as { schema: { parse: (v: unknown) => Record<string, unknown> } })
    .schema;
}

describe.each(CAPABILITIES.map((c) => [c.name, c] as const))('%s argsSchema', (_name, entry) => {
  it('preserves the glossary key instead of silently stripping it', async () => {
    const schema = await schemaOf(entry);
    const parsed = schema.parse({ ...entry.args, glossary: GLOSSARY });
    expect(parsed.glossary).toEqual(GLOSSARY);
  });

  it('accepts an omitted glossary — the feature is optional', async () => {
    const schema = await schemaOf(entry);
    const parsed = schema.parse({ ...entry.args });
    expect(parsed.glossary).toBeUndefined();
  });

  it('bounds the glossary to the injection module cap', async () => {
    const schema = await schemaOf(entry);
    const tooMany = Array.from({ length: GLOSSARY_MAX_TERMS + 1 }, (_, i) => `- term${i}: def.`);
    expect(() => schema.parse({ ...entry.args, glossary: tooMany })).toThrow();
  });
});
