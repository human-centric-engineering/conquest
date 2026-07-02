/**
 * Respondent Report content — pure unit tests (validation + transcript).
 *
 * @see lib/app/questionnaire/report/content.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildAnswerTranscript,
  splitReportParagraphs,
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
    respondentEdited: false,
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

  it('renders boolean/number/object scalars via the shared slot formatter (untyped booleans → Yes/No)', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Mixed',
        slots: [
          // A free-text slot carrying a bare boolean reads as Yes/No (the shared formatter's default),
          // not the raw "true"/"false" the old transcript-only formatter emitted.
          slot({ slotKey: 'b', prompt: 'Agree?', value: true, answered: true }),
          slot({ slotKey: 'n', prompt: 'Score?', value: 7, answered: true }),
          slot({ slotKey: 'o', prompt: 'Meta?', value: { a: 1 }, answered: true }),
          // An answered slot can still carry a null value — it must render (as the em-dash), not be dropped.
          slot({ slotKey: 'z', prompt: 'Blank?', value: null, answered: true }),
        ],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).toContain('A: Yes');
    expect(text).toContain('A: 7');
    expect(text).toContain('A: {"a":1}');
    expect(text).toContain('Q: Blank?\nA: —');
  });

  it('renders a boolean question with its configured true/false labels (matches the PDF/panel)', () => {
    // Regression: the transcript must use the same label-aware rendering as the PDF, so a boolean
    // question with custom labels reads "Strongly agree", never "true".
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'Agreement',
        slots: [
          slot({
            slotKey: 'agree',
            prompt: 'Do you agree?',
            type: 'boolean',
            typeConfig: { trueLabel: 'Strongly agree', falseLabel: 'Strongly disagree' },
            value: true,
            answered: true,
          }),
        ],
      },
    ];
    const text = buildAnswerTranscript({ ...base, sections });
    expect(text).toContain('A: Strongly agree');
    expect(text).not.toContain('A: true');
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

describe('splitReportParagraphs', () => {
  it('splits on blank lines into trimmed paragraphs', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph.';
    expect(splitReportParagraphs(text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
  });

  it('returns a single element when there are no blank-line breaks (one wall of text)', () => {
    expect(splitReportParagraphs('One long block with no breaks.')).toEqual([
      'One long block with no breaks.',
    ]);
  });

  it('keeps a run of single-newline bullet lines together as one paragraph block', () => {
    // Consecutive "- …" lines separated by single newlines are one enumerated block, not N paragraphs.
    const bullets = 'In practice:\n- one\n- two\n- three';
    expect(splitReportParagraphs(bullets)).toEqual(['In practice:\n- one\n- two\n- three']);
  });

  it('separates a bullet block from following prose across a blank line', () => {
    const text = 'Framing line.\n\n- one\n- two\n\nClosing thought.';
    expect(splitReportParagraphs(text)).toEqual([
      'Framing line.',
      '- one\n- two',
      'Closing thought.',
    ]);
  });

  it('tolerates blank lines that contain trailing whitespace', () => {
    const text = 'A.\n   \nB.';
    expect(splitReportParagraphs(text)).toEqual(['A.', 'B.']);
  });

  it('drops empty leading/trailing paragraphs', () => {
    expect(splitReportParagraphs('\n\nBody.\n\n')).toEqual(['Body.']);
  });

  it('splits on CRLF blank lines and leaves no stray carriage returns', () => {
    // Windows-authored answers the model echoes can carry CRLF — normalise to LF so the blank line
    // is still a paragraph break and no \r leaks into the rendered output.
    const result = splitReportParagraphs('Para one.\r\n\r\nPara two.');
    expect(result).toEqual(['Para one.', 'Para two.']);
    expect(result.some((p) => p.includes('\r'))).toBe(false);
  });

  it('sub-splits a long single-block paragraph into groups of ~3 sentences (the wall-of-text fix)', () => {
    // The model returned one block with no blank lines — pass 2 breaks it up regardless.
    const wall = 'One point here. Two follows. Three continues. Four extends. Five closes.';
    expect(splitReportParagraphs(wall)).toEqual([
      'One point here. Two follows. Three continues.',
      'Four extends. Five closes.',
    ]);
  });

  it('leaves a paragraph of three or fewer sentences intact', () => {
    const short = 'First sentence. Second sentence. Third sentence.';
    expect(splitReportParagraphs(short)).toEqual([short]);
  });

  it('does not sentence-split a multi-line bullet block even when it has many sentences', () => {
    const bullets = 'Consequences:\n- One thing. It matters.\n- Two thing. It also matters.';
    expect(splitReportParagraphs(bullets)).toEqual([bullets]);
  });

  it('does not treat a decimal point as a sentence boundary', () => {
    const text = 'You reported 4.5 hours. That is fine. Keep it up. Nothing more needed.';
    // 4 sentences → split after the third; the decimal stays inside its sentence.
    expect(splitReportParagraphs(text)).toEqual([
      'You reported 4.5 hours. That is fine. Keep it up.',
      'Nothing more needed.',
    ]);
  });

  it('breaks a three-sentence block with very long sentences by the character budget', () => {
    // Three long sentences (>280 chars total) → split even though the sentence count is at the cap,
    // so long-sentence prose reads as ~3-line paragraphs, not one 5-line block.
    const s1 =
      'The clearest concern from your answers is the lack of a protected deep work block that you can rely on most days.';
    const s2 =
      'You said you do not currently have at least one protected sixty to ninety minute block, but you did not add detail on what gets in the way.';
    const s3 = 'That makes it hard to judge how your time maps to your stated priorities.';
    const result = splitReportParagraphs(`${s1} ${s2} ${s3}`);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((p) => p.length <= 320)).toBe(true);
    // No sentence is lost or fragmented — rejoining reproduces the original.
    expect(result.join(' ')).toBe(`${s1} ${s2} ${s3}`);
  });

  it('keeps a long punctuation-free block whole (the "≥1 sentence per paragraph" guarantee)', () => {
    // splitSentences yields a single "sentence" for punctuation-free text, so the greedy loop never
    // closes on the first sentence regardless of length — the block stays one paragraph, never fragmented.
    const noPunctuation = 'word '.repeat(120).trim(); // ~600 chars, no . ! ?
    expect(splitReportParagraphs(noPunctuation)).toEqual([noPunctuation]);
  });

  it('combines both passes: blank-line paragraphs, each further capped by sentence count', () => {
    const text = 'Alpha one. Alpha two. Alpha three. Alpha four.\n\nBeta one. Beta two.';
    expect(splitReportParagraphs(text)).toEqual([
      'Alpha one. Alpha two. Alpha three.',
      'Alpha four.',
      'Beta one. Beta two.',
    ]);
  });
});
