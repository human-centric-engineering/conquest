/**
 * Data-slots generation — unit tests
 *
 * Covers the three exported pure functions:
 *   - buildDataSlotGenerationPrompt: verifies message structure, system-prompt
 *     rules text, user-prompt interpolation (goal, question list, section titles)
 *   - buildDataSlotRetryMessage: verifies the retry message content
 *   - validateDataSlotGeneration: verifies schema pass-through for valid/invalid
 *     payloads and correct ZodIssue shape on failure
 *
 * No mocks needed — all functions are pure (no I/O, no Prisma/Next).
 *
 * @see lib/app/questionnaire/data-slots/generation.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildDataSlotGenerationPrompt,
  buildDataSlotMergePrompt,
  buildDataSlotRetryMessage,
  validateDataSlotGeneration,
} from '@/lib/app/questionnaire/data-slots/generation';
import type { DataSlotStructureInput } from '@/lib/app/questionnaire/data-slots/schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const minimalStructure: DataSlotStructureInput = {
  questions: [{ key: 'q1', prompt: 'How easy was onboarding?', type: 'scale' }],
};

const fullStructure: DataSlotStructureInput = {
  goal: 'Understand the onboarding experience',
  audience: { role: 'nurse' },
  questions: [
    { key: 'q1', prompt: 'How easy was onboarding?', type: 'scale', sectionTitle: 'Setup' },
    { key: 'q2', prompt: 'What would you improve?', type: 'open_text', sectionTitle: 'Feedback' },
    { key: 'q3', prompt: 'Would you recommend us?', type: 'nps' },
  ],
};

// Helpers to extract message content by role.
function systemContent(messages: ReturnType<typeof buildDataSlotGenerationPrompt>): string {
  const msg = messages.find((m) => m.role === 'system');
  if (!msg || typeof msg.content !== 'string') throw new Error('Expected string system message');
  return msg.content;
}

function userContent(messages: ReturnType<typeof buildDataSlotGenerationPrompt>): string {
  const msg = messages.find((m) => m.role === 'user');
  if (!msg || typeof msg.content !== 'string') throw new Error('Expected string user message');
  return msg.content;
}

// ---------------------------------------------------------------------------
// buildDataSlotGenerationPrompt — message structure
// ---------------------------------------------------------------------------

describe('buildDataSlotGenerationPrompt — message structure', () => {
  it('returns exactly two messages: system then user', () => {
    const messages = buildDataSlotGenerationPrompt(minimalStructure);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('system and user content are both non-empty strings', () => {
    const messages = buildDataSlotGenerationPrompt(minimalStructure);
    expect(typeof messages[0].content).toBe('string');
    expect(typeof messages[1].content).toBe('string');
    expect((messages[0].content as string).length).toBeGreaterThan(0);
    expect((messages[1].content as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildDataSlotGenerationPrompt — system prompt rules
// ---------------------------------------------------------------------------

describe('buildDataSlotGenerationPrompt — system prompt rules', () => {
  const system = systemContent(buildDataSlotGenerationPrompt(minimalStructure));

  it('instructs the model about what a data slot is (1–4 words, semantic target)', () => {
    expect(system).toMatch(/data slot/i);
    expect(system).toMatch(/1.?4 word/i);
  });

  it('instructs the model to cover every question', () => {
    expect(system).toMatch(/cover every question/i);
  });

  it('describes the expected JSON output structure with slots array', () => {
    expect(system).toContain('"slots"');
    expect(system).toContain('"name"');
    expect(system).toContain('"description"');
    expect(system).toContain('"theme"');
    expect(system).toContain('"questionKeys"');
    expect(system).toContain('"confidence"');
  });

  it('instructs the model to reply with JSON only (no prose/markdown)', () => {
    expect(system).toMatch(/no prose.*no markdown|JSON only/i);
  });

  it('instructs the model to map each slot to one or more question keys', () => {
    expect(system).toMatch(/one or more question/i);
  });

  it('explains that the theme is a grouping label', () => {
    expect(system).toMatch(/theme/i);
    expect(system).toMatch(/group/i);
  });

  it('demands detailed descriptions that carry the full intent of the questions', () => {
    expect(system).toMatch(/descriptions are critical/i);
    expect(system).toMatch(/full intent/i);
    expect(system).toMatch(/never drop detail/i);
  });
});

// ---------------------------------------------------------------------------
// buildDataSlotGenerationPrompt — granularity
// ---------------------------------------------------------------------------

describe('buildDataSlotGenerationPrompt — granularity', () => {
  it('injects the balanced guidance by default (no granularity argument)', () => {
    const system = systemContent(buildDataSlotGenerationPrompt(minimalStructure));
    expect(system).toMatch(/GRANULARITY for this set:/);
    expect(system).toMatch(/balance breadth and detail/i);
  });

  it('injects the broadest guidance when asked to consolidate aggressively', () => {
    const system = systemContent(buildDataSlotGenerationPrompt(minimalStructure, 'broadest'));
    expect(system).toMatch(/consolidate aggressively/i);
    expect(system).not.toMatch(/maximise granularity/i);
  });

  it('injects the finest guidance when asked for maximum granularity', () => {
    const system = systemContent(buildDataSlotGenerationPrompt(minimalStructure, 'finest'));
    expect(system).toMatch(/maximise granularity/i);
    expect(system).toMatch(/1:1 mapping/i);
  });
});

// ---------------------------------------------------------------------------
// buildDataSlotMergePrompt — reconcile step
// ---------------------------------------------------------------------------

describe('buildDataSlotMergePrompt', () => {
  const candidates = [
    {
      name: 'Onboarding ease',
      description: 'How smooth setup felt.',
      theme: 'Setup',
      questionKeys: ['q1'],
    },
    { name: 'Blockers', description: 'What slowed them.', theme: 'Setup', questionKeys: ['q2'] },
    {
      name: 'Recommend',
      description: 'Would they recommend.',
      theme: 'Loyalty',
      questionKeys: ['q3'],
    },
  ];

  it('returns a system + user message pair', () => {
    const messages = buildDataSlotMergePrompt(fullStructure, candidates);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('instructs the model to reconcile/merge duplicates and cover every question', () => {
    const system = systemContent(buildDataSlotMergePrompt(fullStructure, candidates));
    expect(system).toMatch(/reconciling/i);
    expect(system).toMatch(/duplicates/i);
    expect(system).toMatch(/cover every question/i);
    expect(system).toMatch(/full intent/i);
  });

  it('lists the candidate slots and all question keys in the user message', () => {
    const user = userContent(buildDataSlotMergePrompt(fullStructure, candidates));
    expect(user).toContain('Onboarding ease');
    expect(user).toContain('Recommend');
    expect(user).toContain('[q1]');
    expect(user).toContain('[q3]');
  });

  it('carries the granularity guidance into the merge system prompt', () => {
    const system = systemContent(buildDataSlotMergePrompt(fullStructure, candidates, 'broadest'));
    expect(system).toMatch(/consolidate aggressively/i);
  });
});

// ---------------------------------------------------------------------------
// buildDataSlotGenerationPrompt — user prompt interpolation
// ---------------------------------------------------------------------------

describe('buildDataSlotGenerationPrompt — user prompt interpolation', () => {
  it('includes the goal line when a goal is provided', () => {
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    expect(user).toContain('Questionnaire goal:');
    expect(user).toContain('Understand the onboarding experience');
  });

  it('omits the goal line when no goal is present', () => {
    const user = userContent(buildDataSlotGenerationPrompt(minimalStructure));
    expect(user).not.toContain('Questionnaire goal:');
  });

  it('lists every question with its key and type', () => {
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    expect(user).toContain('[q1]');
    expect(user).toContain('[q2]');
    expect(user).toContain('[q3]');
    expect(user).toContain('scale');
    expect(user).toContain('open_text');
    expect(user).toContain('nps');
  });

  it('includes each question prompt text', () => {
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    expect(user).toContain('How easy was onboarding?');
    expect(user).toContain('What would you improve?');
    expect(user).toContain('Would you recommend us?');
  });

  it('includes sectionTitle in the question line when present', () => {
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    expect(user).toContain('section: Setup');
    expect(user).toContain('section: Feedback');
  });

  it('omits section label for questions without a sectionTitle', () => {
    // q3 has no sectionTitle — the line must not contain "section:"
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    const q3Line = user.split('\n').find((l) => l.includes('[q3]'));
    expect(q3Line).toBeDefined();
    expect(q3Line).not.toContain('section:');
  });

  it('states the question count in the user message', () => {
    const user = userContent(buildDataSlotGenerationPrompt(fullStructure));
    expect(user).toContain(`Questions (${fullStructure.questions.length})`);
  });

  it('ends with a call-to-action to design the slots', () => {
    const user = userContent(buildDataSlotGenerationPrompt(minimalStructure));
    expect(user).toMatch(/design the data slots/i);
  });
});

// ---------------------------------------------------------------------------
// buildDataSlotRetryMessage
// ---------------------------------------------------------------------------

describe('buildDataSlotRetryMessage', () => {
  it('returns a non-empty string', () => {
    const message = buildDataSlotRetryMessage();
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it('states that the previous reply was not valid', () => {
    const message = buildDataSlotRetryMessage();
    expect(message).toMatch(/not valid/i);
  });

  it('includes the expected JSON structure keys in the retry instruction', () => {
    const message = buildDataSlotRetryMessage();
    expect(message).toContain('"slots"');
    expect(message).toContain('"name"');
    expect(message).toContain('"description"');
    expect(message).toContain('"theme"');
    expect(message).toContain('"questionKeys"');
    expect(message).toContain('"confidence"');
  });

  it('tells the model to reply with nothing else (JSON only)', () => {
    const message = buildDataSlotRetryMessage();
    expect(message).toMatch(/nothing else|ONLY the JSON/i);
  });
});

// ---------------------------------------------------------------------------
// validateDataSlotGeneration
// ---------------------------------------------------------------------------

describe('validateDataSlotGeneration', () => {
  const validOutput = {
    slots: [
      {
        name: 'Onboarding ease',
        description: 'How straightforward the initial setup feels.',
        theme: 'Onboarding',
        questionKeys: ['q1'],
        confidence: 0.9,
      },
    ],
  };

  it('returns { ok: true, value } for a valid payload', () => {
    const result = validateDataSlotGeneration(validOutput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slots).toHaveLength(1);
      expect(result.value.slots[0].name).toBe('Onboarding ease');
    }
  });

  it('applies schema defaults — confidence defaults to 0.5 when omitted', () => {
    const withoutConf = {
      slots: [
        {
          name: 'Time to value',
          description: 'Speed to first outcome.',
          theme: 'Value',
        },
      ],
    };
    const result = validateDataSlotGeneration(withoutConf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slots[0].confidence).toBe(0.5);
    }
  });

  it('returns { ok: false, issues } for an invalid payload', () => {
    const result = validateDataSlotGeneration({ slots: [{ name: '' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns ZodIssue objects with a path and message for field-level errors', () => {
    const result = validateDataSlotGeneration({
      slots: [{ ...validOutput.slots[0], confidence: 999 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const confidenceIssue = result.issues.find((i) => i.path.includes('confidence'));
      expect(confidenceIssue).toBeDefined();
      expect(typeof confidenceIssue?.message).toBe('string');
    }
  });

  it('returns { ok: false } for non-object input', () => {
    expect(validateDataSlotGeneration(null).ok).toBe(false);
    expect(validateDataSlotGeneration('not an object').ok).toBe(false);
    expect(validateDataSlotGeneration(42).ok).toBe(false);
  });

  it('returns { ok: false } when slots key is missing', () => {
    expect(validateDataSlotGeneration({}).ok).toBe(false);
  });

  it('returns { ok: false } when slots exceed 60', () => {
    const tooMany = {
      slots: Array.from({ length: 61 }, (_, i) => ({
        name: `Slot ${i + 1}`,
        description: 'desc',
        theme: 'T',
        questionKeys: [],
        confidence: 0.5,
      })),
    };
    expect(validateDataSlotGeneration(tooMany).ok).toBe(false);
  });
});
