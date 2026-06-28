/**
 * Unit tests for the Structure Edit Agent translation prompt builder.
 *
 * Pure, IO-free string assembly: a compact ordinal-anchored summary of the structure plus the
 * system framing that constrains the model to emit a valid edit-op plan. The tests pin the summary
 * format (ordinals, key/type/required/weight, prompt truncation), the two-message shape, and the
 * retry nudge — the Zod schema remains the real safety net, so these only guard the prose contract.
 */

import { describe, it, expect } from 'vitest';

import {
  summarizeStructure,
  buildTranslatePrompt,
  buildTranslateRetryMessage,
} from '@/lib/app/questionnaire/edit-agent/translate-prompt';
import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';

function structure(overrides: Partial<EditableStructure> = {}): EditableStructure {
  return {
    versionId: 'ver-1',
    sections: [
      {
        id: 'sec-1',
        ordinal: 0,
        title: 'About You',
        description: null,
        questions: [
          {
            id: 'q-1',
            key: 'full_name',
            ordinal: 0,
            prompt: 'What is your full name?',
            type: 'free_text',
            required: true,
            weight: 0.5,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('summarizeStructure', () => {
  it('anchors each section by its ordinal and title', () => {
    const out = summarizeStructure(structure());
    expect(out).toContain('Section [ordinal 0]: About You');
  });

  it('renders each question with key, type, required, and weight (2dp)', () => {
    const out = summarizeStructure(structure());
    expect(out).toContain('key="full_name" type=free_text required=true weight=0.50');
    expect(out).toContain('prompt="What is your full name?"');
  });

  it('marks a section with no questions explicitly', () => {
    const out = summarizeStructure(
      structure({
        sections: [{ id: 's', ordinal: 2, title: 'Empty', description: null, questions: [] }],
      })
    );
    expect(out).toContain('Section [ordinal 2]: Empty');
    expect(out).toContain('(no questions)');
  });

  it('truncates a long prompt to the cap with an ellipsis', () => {
    const longPrompt = 'x'.repeat(200);
    const out = summarizeStructure(
      structure({
        sections: [
          {
            id: 's',
            ordinal: 0,
            title: 'S',
            description: null,
            questions: [
              {
                id: 'q',
                key: 'k',
                ordinal: 0,
                prompt: longPrompt,
                type: 'free_text',
                required: false,
                weight: 1,
              },
            ],
          },
        ],
      })
    );
    // Cap is 140: 139 chars + ellipsis, and the full 200-char prompt is not present verbatim.
    expect(out).toContain(`${'x'.repeat(139)}…`);
    expect(out).not.toContain(longPrompt);
  });

  it('preserves section order across multiple sections', () => {
    const out = summarizeStructure(
      structure({
        sections: [
          { id: 'a', ordinal: 0, title: 'First', description: null, questions: [] },
          { id: 'b', ordinal: 1, title: 'Second', description: null, questions: [] },
        ],
      })
    );
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });
});

describe('buildTranslatePrompt', () => {
  it('returns a system message then a user message', () => {
    const messages = buildTranslatePrompt('Renumber the sections', structure());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('embeds the instruction and the structure summary in the user message', () => {
    const messages = buildTranslatePrompt('CAPS every section title', structure());
    const user = messages[1].content;
    expect(user).toContain('CAPS every section title');
    expect(user).toContain('Section [ordinal 0]: About You');
    // Steers the model to emit only the JSON envelope the validator expects.
    expect(user).toContain('"operations"');
  });

  it('describes the available operations and selectors in the system message', () => {
    const system = buildTranslatePrompt('x', structure())[0].content;
    expect(system).toContain('set_required');
    expect(system).toContain('renumber_sections');
    expect(system).toContain('"scope":"type"');
  });
});

describe('buildTranslateRetryMessage', () => {
  it('returns a JSON-only nudge', () => {
    const msg = buildTranslateRetryMessage();
    expect(msg).toContain('valid plan');
    expect(msg).toContain('"operations"');
  });
});
