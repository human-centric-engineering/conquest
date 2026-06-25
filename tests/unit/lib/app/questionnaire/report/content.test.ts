/**
 * Respondent Report content — pure unit tests (validation + transcript).
 *
 * @see lib/app/questionnaire/report/content.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildAnswerTranscript,
  validateRespondentReportContent,
  REPORT_SUMMARY_MAX,
  REPORT_MAX_SECTIONS,
  REPORT_MAX_ACTIONS,
  type AnswerTranscriptInput,
} from '@/lib/app/questionnaire/report/content';
import type { PanelSlotView, PanelSectionView } from '@/lib/app/questionnaire/panel/types';

function slot(over: Partial<PanelSlotView> = {}): PanelSlotView {
  return {
    slotKey: 'q1',
    prompt: 'How are you?',
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: true,
    value: 'Good',
    provenance: 'direct',
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

describe('validateRespondentReportContent', () => {
  it('accepts a well-formed payload', () => {
    const result = validateRespondentReportContent({
      summary: 'You did well.',
      sections: [{ heading: 'Strengths', body: 'You are consistent.' }],
      actions: ['Keep a journal'],
    });
    expect(result).toEqual({
      summary: 'You did well.',
      sections: [{ heading: 'Strengths', body: 'You are consistent.' }],
      actions: ['Keep a journal'],
    });
  });

  it('returns null when the value is not a record or has no usable summary', () => {
    expect(validateRespondentReportContent(null)).toBeNull();
    expect(validateRespondentReportContent('nope')).toBeNull();
    expect(validateRespondentReportContent({ sections: [], actions: [] })).toBeNull();
    expect(validateRespondentReportContent({ summary: '   ' })).toBeNull();
  });

  it('drops malformed sections and actions instead of failing the whole report', () => {
    const result = validateRespondentReportContent({
      summary: 'ok',
      sections: [
        { heading: 'Good', body: 'has both' },
        { heading: 'No body' }, // dropped
        { body: 'No heading' }, // dropped
        'not an object', // dropped
      ],
      actions: ['valid', '', 42, '  spaced  '],
    });
    expect(result?.sections).toEqual([{ heading: 'Good', body: 'has both' }]);
    expect(result?.actions).toEqual(['valid', 'spaced']);
  });

  it('caps section and action counts and trims/length-caps the summary', () => {
    const result = validateRespondentReportContent({
      summary: 'x'.repeat(REPORT_SUMMARY_MAX + 100),
      sections: Array.from({ length: REPORT_MAX_SECTIONS + 5 }, (_, i) => ({
        heading: `H${i}`,
        body: `B${i}`,
      })),
      actions: Array.from({ length: REPORT_MAX_ACTIONS + 5 }, (_, i) => `a${i}`),
    });
    expect(result?.summary).toHaveLength(REPORT_SUMMARY_MAX);
    expect(result?.sections).toHaveLength(REPORT_MAX_SECTIONS);
    expect(result?.actions).toHaveLength(REPORT_MAX_ACTIONS);
  });
});

describe('buildAnswerTranscript', () => {
  const base: AnswerTranscriptInput = {
    questionnaireTitle: 'Pulse',
    goal: 'Understand engagement',
    audienceSummary: 'Employees',
    sections: [],
  };

  it('includes the goal/audience header and only answered slots', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Wellbeing',
        slots: [
          slot({ slotKey: 'q1', prompt: 'Mood?', value: 'Positive', answered: true }),
          slot({ slotKey: 'q2', prompt: 'Pending?', value: null, answered: false }),
        ],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).toContain('Questionnaire: Pulse');
    expect(text).toContain('Goal: Understand engagement');
    expect(text).toContain('Audience: Employees');
    expect(text).toContain('## Wellbeing');
    expect(text).toContain('Q: Mood?');
    expect(text).toContain('A: Positive');
    // Unanswered slot is excluded.
    expect(text).not.toContain('Pending?');
  });

  it('skips sections with no answered slots', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Empty',
        slots: [slot({ answered: false, value: null })],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).not.toContain('## Empty');
  });

  it('formats array answers as a comma list', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Choices',
        slots: [slot({ prompt: 'Pick', value: ['a', 'b', 'c'], answered: true })],
      },
    ];
    expect(buildAnswerTranscript({ ...base, sections })).toContain('A: a, b, c');
  });

  it('renders choice answers as their option labels, not stored keys', () => {
    const choiceConfig = {
      choices: [
        { value: 'opt_a', label: 'Very satisfied' },
        { value: 'opt_b', label: 'Dissatisfied' },
      ],
    };
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Feedback',
        slots: [
          slot({
            slotKey: 'sat',
            prompt: 'Satisfaction?',
            type: 'single_choice',
            typeConfig: choiceConfig,
            value: 'opt_a',
            answered: true,
          }),
          slot({
            slotKey: 'likes',
            prompt: 'Liked?',
            type: 'multi_choice',
            typeConfig: choiceConfig,
            value: ['opt_a', 'opt_b'],
            answered: true,
          }),
        ],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).toContain('A: Very satisfied');
    expect(text).toContain('A: Very satisfied, Dissatisfied');
    expect(text).not.toContain('opt_a');
  });

  it('formats scalar answer types (boolean, number, object) and renders null as "(no answer)"', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Mixed',
        slots: [
          slot({ slotKey: 'b', prompt: 'Agree?', value: true, answered: true }),
          slot({ slotKey: 'n', prompt: 'Score?', value: 7, answered: true }),
          slot({ slotKey: 'o', prompt: 'Meta?', value: { a: 1 }, answered: true }),
          // An answered slot can still carry a null value — it must render, not be dropped.
          slot({ slotKey: 'z', prompt: 'Blank?', value: null, answered: true }),
        ],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).toContain('A: true');
    expect(text).toContain('A: 7');
    expect(text).toContain('A: {"a":1}');
    expect(text).toContain('Q: Blank?\nA: (no answer)');
  });

  it('omits goal/audience header lines when absent', () => {
    const sections: PanelSectionView[] = [
      { sectionId: 's1', title: 'S', slots: [slot({ answered: true, value: 'x' })] },
    ];
    const text = buildAnswerTranscript({
      questionnaireTitle: 'T',
      goal: null,
      audienceSummary: null,
      sections,
    });
    expect(text).not.toContain('Goal:');
    expect(text).not.toContain('Audience:');
  });
});
