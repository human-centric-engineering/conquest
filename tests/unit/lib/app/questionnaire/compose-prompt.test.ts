/**
 * Unit tests for compose-prompt.ts — the prompt builder for generative authoring.
 *
 * All functions are pure (no IO, no provider imports). Tests verify the structural
 * contract (system message + user message) and that runtime-conditional branches are
 * exercised: adminSupplied present/absent, section description and goal present/absent,
 * retry message with/without issue paths.
 *
 * @see lib/app/questionnaire/ingestion/compose-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildComposeOutlinePrompt,
  buildComposeSectionQuestionsPrompt,
  buildComposeFullPrompt,
  buildRefineStructurePrompt,
  buildComposeRetryMessage,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import type { ComposeStructure } from '@/lib/app/questionnaire/ingestion/compose-schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF = 'A short employee-satisfaction survey for a mid-sized tech company.';

const CURRENT_STRUCTURE: ComposeStructure = {
  sections: [{ ordinal: 0, title: 'Background', description: 'About the respondent' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'tenure',
      prompt: 'How long have you worked here?',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
  ],
};

// ---------------------------------------------------------------------------
// buildComposeOutlinePrompt
// ---------------------------------------------------------------------------

describe('buildComposeOutlinePrompt', () => {
  it('returns exactly two messages: system then user', () => {
    const messages = buildComposeOutlinePrompt(BRIEF);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('embeds the brief in the user message', () => {
    const messages = buildComposeOutlinePrompt(BRIEF);
    expect(messages[1]?.content).toContain(BRIEF);
  });

  it('tells the model to infer goal and audience when adminSupplied is absent', () => {
    const messages = buildComposeOutlinePrompt(BRIEF);
    expect(messages[1]?.content).toContain('infer both from the brief');
  });

  it('names the suppressed fields when adminSupplied includes a goal', () => {
    const messages = buildComposeOutlinePrompt(BRIEF, { goal: 'Measure engagement' });
    const userContent = messages[1]?.content ?? '';
    // The suppression line should name "goal" as a do-not-infer field.
    expect(userContent).toContain('goal');
    expect(userContent).toContain('do NOT infer');
  });

  it('names audience sub-fields when adminSupplied includes audience fields', () => {
    const messages = buildComposeOutlinePrompt(BRIEF, {
      audience: { role: 'engineer', expertiseLevel: 'intermediate' },
    });
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('audience.role');
    expect(userContent).toContain('audience.expertiseLevel');
    expect(userContent).toContain('do NOT infer');
  });

  it('suppresses only the set fields, leaving unset audience fields infer-able', () => {
    // Only role is set — expertiseLevel is absent, so it remains infer-able.
    const messages = buildComposeOutlinePrompt(BRIEF, { audience: { role: 'manager' } });
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('audience.role');
    expect(userContent).toContain('infer any audience field not in that list');
  });
});

// ---------------------------------------------------------------------------
// buildComposeSectionQuestionsPrompt
// ---------------------------------------------------------------------------

describe('buildComposeSectionQuestionsPrompt', () => {
  const BASE_SECTION = {
    ordinal: 1,
    title: 'Work Environment',
    siblingTitles: ['Background', 'Work Environment', 'Wrap-up'],
  };

  it('returns exactly two messages: system then user', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('includes the section ordinal and title in the user message', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('1');
    expect(userContent).toContain('"Work Environment"');
  });

  it('lists sibling titles in the user message for cross-section context', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('Background');
    expect(userContent).toContain('Wrap-up');
  });

  it('includes the section description in the header when present', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, {
      ...BASE_SECTION,
      description: 'Physical and remote work conditions',
    });
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('Physical and remote work conditions');
  });

  it('omits the description clause entirely when description is absent', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    const userContent = messages[1]?.content ?? '';
    // No description → the "Write questions for THIS section" line should not have a parenthetical.
    expect(userContent).not.toMatch(/ordinal \d+: "[^"]*" \(/);
  });

  it('prefixes the header with the questionnaire goal when goal is present', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, {
      ...BASE_SECTION,
      goal: 'Identify burnout risk factors',
    });
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('Identify burnout risk factors');
    expect(userContent).toContain('Questionnaire goal:');
  });

  it('omits the goal line entirely when goal is absent', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).not.toContain('Questionnaire goal:');
  });

  it('embeds the brief between the delimiters', () => {
    const messages = buildComposeSectionQuestionsPrompt(BRIEF, BASE_SECTION);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('--- BEGIN BRIEF ---');
    expect(userContent).toContain(BRIEF);
    expect(userContent).toContain('--- END BRIEF ---');
  });
});

// ---------------------------------------------------------------------------
// buildComposeFullPrompt
// ---------------------------------------------------------------------------

describe('buildComposeFullPrompt', () => {
  it('returns exactly two messages: system then user', () => {
    const messages = buildComposeFullPrompt(BRIEF);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('embeds the brief in the user message between the delimiters', () => {
    const messages = buildComposeFullPrompt(BRIEF);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain(BRIEF);
    expect(userContent).toContain('--- BEGIN BRIEF ---');
    expect(userContent).toContain('--- END BRIEF ---');
  });

  it('tells the model to infer when adminSupplied is absent', () => {
    const messages = buildComposeFullPrompt(BRIEF);
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('infer both from the brief');
  });

  it('names suppressed fields when adminSupplied is present', () => {
    const messages = buildComposeFullPrompt(BRIEF, {
      goal: 'Measure satisfaction',
      audience: { role: 'HR manager' },
    });
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('goal');
    expect(userContent).toContain('audience.role');
    expect(userContent).toContain('do NOT infer');
  });

  it('system message instructs the model to emit sections AND questions together', () => {
    const messages = buildComposeFullPrompt(BRIEF);
    const systemContent = messages[0]?.content ?? '';
    // The full-structure system prompt should mention both "sections" and "questions".
    expect(systemContent).toContain('sections');
    expect(systemContent).toContain('questions');
  });

  it('requires choice options as {value,label} objects, not a bare string array', () => {
    const systemContent = buildComposeFullPrompt(BRIEF)[0]?.content ?? '';
    // Mirror of the extractor fix: composed choice questions must carry object options.
    expect(systemContent).toMatch(/single_choice[\s\S]*multi_choice/i);
    expect(systemContent).toMatch(/array of objects/i);
    expect(systemContent).not.toContain('"choices":["A","B"]');
  });
});

// ---------------------------------------------------------------------------
// buildRefineStructurePrompt
// ---------------------------------------------------------------------------

describe('buildRefineStructurePrompt', () => {
  it('returns exactly two messages: system then user', () => {
    const messages = buildRefineStructurePrompt(CURRENT_STRUCTURE, 'Make it shorter');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('includes the instruction in the user message', () => {
    const messages = buildRefineStructurePrompt(CURRENT_STRUCTURE, 'Add a section on pricing');
    const userContent = messages[1]?.content ?? '';
    expect(userContent).toContain('Add a section on pricing');
    expect(userContent).toContain('Instruction:');
  });

  it('embeds the current structure as JSON in the user message', () => {
    const messages = buildRefineStructurePrompt(CURRENT_STRUCTURE, 'Make it shorter');
    const userContent = messages[1]?.content ?? '';
    // The structure is serialized; verify a key field appears.
    expect(userContent).toContain('"Background"');
    expect(userContent).toContain('--- BEGIN CURRENT STRUCTURE (JSON) ---');
    expect(userContent).toContain('--- END CURRENT STRUCTURE ---');
  });

  it('system message mentions preserving existing question keys', () => {
    const messages = buildRefineStructurePrompt(CURRENT_STRUCTURE, 'Make it shorter');
    const systemContent = messages[0]?.content ?? '';
    // The refine system prompt should emphasise key stability.
    expect(systemContent).toContain('"key"');
  });
});

// ---------------------------------------------------------------------------
// buildComposeRetryMessage
// ---------------------------------------------------------------------------

describe('buildComposeRetryMessage', () => {
  it('produces a generic message when no issue paths are provided', () => {
    const msg = buildComposeRetryMessage([]);
    expect(msg).toContain('not valid JSON for the required schema');
    expect(msg).not.toContain('invalid at:');
  });

  it('lists the invalid paths when issue paths are present', () => {
    const msg = buildComposeRetryMessage(['sections.0.title', 'questions']);
    expect(msg).toContain('invalid at:');
    expect(msg).toContain('sections.0.title');
    expect(msg).toContain('questions');
  });

  it('always opens with the JSON-only instruction regardless of paths', () => {
    expect(buildComposeRetryMessage([])).toContain('Return ONLY the JSON object');
    expect(buildComposeRetryMessage(['foo'])).toContain('Return ONLY the JSON object');
  });
});
