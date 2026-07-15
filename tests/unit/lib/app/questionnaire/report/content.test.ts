/**
 * Respondent Report content — pure unit tests (validation + transcript).
 *
 * @see lib/app/questionnaire/report/content.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildAnswerTranscript,
  buildDataSlotContextBlock,
  partialReportCaveat,
  splitReportParagraphs,
  validateRespondentReportContent,
  validateResearch,
  validateAppendix,
  PARTIAL_REPORT_THRESHOLD_PCT,
  REPORT_SUMMARY_MAX,
  REPORT_MAX_SECTIONS,
  REPORT_MAX_ACTIONS,
  REPORT_MAX_RESEARCH_FINDINGS,
  REPORT_APPENDIX_HEADING_MAX,
  REPORT_APPENDIX_BODY_MAX,
  type AnswerTranscriptInput,
} from '@/lib/app/questionnaire/report/content';
import type { PanelSlotView, PanelSectionView } from '@/lib/app/questionnaire/panel/types';
import type { ExportDataSlotGroup } from '@/lib/app/questionnaire/export/types';

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
    audience: { description: 'Employees' },
    sections: [],
  };

  it('renders every set structured-audience field as a labelled line', () => {
    const text = buildAnswerTranscript({
      ...base,
      audience: {
        description: 'Frontline managers',
        role: 'Team lead',
        expertiseLevel: 'intermediate',
        estimatedDurationMinutes: 15,
        locale: 'en-GB',
        sensitivity: 'high',
        notes: 'Recently reorganised.',
      },
    });
    expect(text).toContain('Audience: Frontline managers');
    expect(text).toContain('Audience role: Team lead');
    expect(text).toContain('Audience expertise level: intermediate');
    expect(text).toContain('Estimated completion time: 15 minutes');
    expect(text).toContain('Locale: en-GB');
    expect(text).toContain('Topic sensitivity: high');
    expect(text).toContain('Audience notes: Recently reorganised.');
  });

  it('omits audience lines entirely when no audience is set', () => {
    const text = buildAnswerTranscript({ ...base, audience: null });
    expect(text).not.toContain('Audience');
  });

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
      audience: null,
      sections,
    });
    expect(text).not.toContain('Goal:');
    expect(text).not.toContain('Audience:');
  });

  it('annotates each answer with its confidence when includeConfidence is on', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'S',
        slots: [slot({ prompt: 'Mood?', value: 'Good', answered: true, confidence: 0.42 })],
      },
    ];
    expect(buildAnswerTranscript({ ...base, sections }, { includeConfidence: true })).toContain(
      'A: Good (confidence 0.42)'
    );
  });

  it('omits the confidence suffix by default and when the answer has no confidence', () => {
    const sections: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'S',
        slots: [slot({ prompt: 'Mood?', value: 'Good', answered: true, confidence: 0.9 })],
      },
    ];
    // Off by default.
    expect(buildAnswerTranscript({ ...base, sections })).not.toContain('confidence');
    // On, but the slot carries no confidence → no suffix.
    const noConf: PanelSectionView[] = [
      {
        sectionId: 's1',
        title: 'S',
        slots: [slot({ value: 'Good', answered: true, confidence: null })],
      },
    ];
    expect(
      buildAnswerTranscript({ ...base, sections: noConf }, { includeConfidence: true })
    ).not.toContain('confidence');
  });
});

describe('buildDataSlotContextBlock', () => {
  const groups: ExportDataSlotGroup[] = [
    {
      theme: 'Motivation',
      slots: [
        {
          name: 'Primary driver',
          description: null,
          value: 'Career growth',
          rationale: 'Said so twice',
          confidence: 0.72,
        },
        { name: 'Blocker', description: null, value: null, rationale: null, confidence: null }, // unfilled → skipped
      ],
    },
    {
      theme: '',
      slots: [
        { name: 'Tenure', description: null, value: '3 years', rationale: null, confidence: 0.5 },
      ],
    },
  ];

  it('renders themed, filled slots with rationale + confidence when includeConfidence is on', () => {
    const text = buildDataSlotContextBlock(groups, { includeConfidence: true });
    expect(text).toContain('## Motivation');
    expect(text).toContain('Primary driver: Career growth (confidence 0.72)');
    expect(text).toContain('  Why: Said so twice');
    // Themeless group renders its slot without a heading.
    expect(text).toContain('Tenure: 3 years (confidence 0.50)');
    // Unfilled slot is skipped entirely.
    expect(text).not.toContain('Blocker');
  });

  it('omits confidence suffixes when includeConfidence is off', () => {
    const text = buildDataSlotContextBlock(groups, { includeConfidence: false });
    expect(text).toContain('Primary driver: Career growth');
    expect(text).not.toContain('confidence');
  });

  it('returns an empty string for no groups, undefined, or all-unfilled slots', () => {
    expect(buildDataSlotContextBlock([])).toBe('');
    expect(buildDataSlotContextBlock(undefined)).toBe('');
    expect(
      buildDataSlotContextBlock([
        { theme: 'T', slots: [{ name: 'X', description: null, value: null }] },
      ])
    ).toBe('');
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

  describe('trustParagraphs (formatter-produced prose)', () => {
    it('honours authored blank-line breaks without re-chopping a long paragraph', () => {
      // A deliberate 4-sentence paragraph the formatter chose to keep whole. Default mode would
      // re-group it into ≤3-sentence chunks; trust mode leaves it exactly as authored.
      const text = 'Alpha one. Alpha two. Alpha three. Alpha four.\n\nBeta one. Beta two.';
      expect(splitReportParagraphs(text, { trustParagraphs: true })).toEqual([
        'Alpha one. Alpha two. Alpha three. Alpha four.',
        'Beta one. Beta two.',
      ]);
    });

    it('does not sub-split a single wall-of-text block in trust mode', () => {
      const wall = 'One. Two. Three. Four. Five. Six.';
      // Default mode would chop this into groups of ~3 sentences; trust mode returns it whole.
      expect(splitReportParagraphs(wall, { trustParagraphs: true })).toEqual([wall]);
    });

    it('still preserves multi-line bullet blocks verbatim in trust mode', () => {
      const bullets = 'In practice:\n- one\n- two\n- three';
      expect(splitReportParagraphs(bullets, { trustParagraphs: true })).toEqual([bullets]);
    });

    it('still normalises CRLF and drops empty paragraphs in trust mode', () => {
      const result = splitReportParagraphs('Para one.\r\n\r\nPara two.\r\n\r\n', {
        trustParagraphs: true,
      });
      expect(result).toEqual(['Para one.', 'Para two.']);
    });
  });
});

describe('partialReportCaveat', () => {
  it('returns null at or above the threshold (a complete-enough questionnaire needs no caveat)', () => {
    expect(partialReportCaveat(PARTIAL_REPORT_THRESHOLD_PCT)).toBeNull();
    expect(partialReportCaveat(80)).toBeNull();
    expect(partialReportCaveat(100)).toBeNull();
  });

  it('returns null when completion is unknown (null/undefined — legacy rows carry no caveat)', () => {
    expect(partialReportCaveat(null)).toBeNull();
    expect(partialReportCaveat(undefined)).toBeNull();
  });

  it('returns a caveat naming the exact percentage below the threshold', () => {
    const caveat = partialReportCaveat(40);
    expect(caveat).not.toBeNull();
    // The exact figure is interpolated (deterministic — never entrusted to an LLM).
    expect(caveat).toContain('(40% complete)');
    expect(caveat).toMatch(/partially complete questionnaire/i);
    expect(caveat).toMatch(/complete the full questionnaire/i);
  });

  it('treats the threshold as exclusive on the lower side (74 → caveat, 75 → none)', () => {
    expect(partialReportCaveat(PARTIAL_REPORT_THRESHOLD_PCT - 1)).toContain('74% complete');
    expect(partialReportCaveat(PARTIAL_REPORT_THRESHOLD_PCT)).toBeNull();
  });
});

describe('validateResearch', () => {
  it('returns null for non-records and for a block with no usable content', () => {
    expect(validateResearch(null)).toBeNull();
    expect(validateResearch('nope')).toBeNull();
    expect(validateResearch({ findings: [] })).toBeNull();
    expect(validateResearch({ findings: [{ title: '', url: '' }] })).toBeNull();
  });

  it('keeps well-formed findings and defaults the display to list', () => {
    const res = validateResearch({
      findings: [
        {
          title: 'A source',
          url: 'https://example.com/a',
          snippet: 'About A',
          source: 'example.com',
        },
      ],
      note: 'A short synthesis.',
    });
    expect(res).toEqual({
      findings: [
        {
          title: 'A source',
          url: 'https://example.com/a',
          snippet: 'About A',
          source: 'example.com',
        },
      ],
      note: 'A short synthesis.',
      display: 'list',
    });
  });

  it('preserves an explicit table display', () => {
    const res = validateResearch({
      findings: [{ title: 'T', url: 'https://x.test' }],
      display: 'table',
    });
    expect(res?.display).toBe('table');
  });

  it('drops findings without a valid http(s) URL (and non-web schemes)', () => {
    const res = validateResearch({
      findings: [
        { title: 'Bad scheme', url: 'javascript:alert(1)' },
        { title: 'No url', url: '' },
        { title: 'Not a url', url: 'not a url' },
        { title: 'Good', url: 'http://ok.test/path' },
      ],
    });
    expect(res?.findings).toEqual([{ title: 'Good', url: 'http://ok.test/path', snippet: '' }]);
  });

  it('caps the number of findings', () => {
    const many = Array.from({ length: REPORT_MAX_RESEARCH_FINDINGS + 5 }, (_, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
    }));
    const res = validateResearch({ findings: many });
    expect(res?.findings).toHaveLength(REPORT_MAX_RESEARCH_FINDINGS);
  });

  it('keeps a note-only block (findings may legitimately be empty)', () => {
    const res = validateResearch({ findings: [], note: 'Nothing conclusive found.' });
    expect(res).toEqual({ findings: [], note: 'Nothing conclusive found.', display: 'list' });
  });

  it('tolerates a missing findings key (non-array) and still keeps a note', () => {
    // No `findings` key at all → the `Array.isArray(parsed.findings)` guard falls back to [].
    const res = validateResearch({ note: 'Only a synthesis, no sources.' });
    expect(res).toEqual({ findings: [], note: 'Only a synthesis, no sources.', display: 'list' });
  });

  it('skips non-object entries in the findings array without discarding the whole block', () => {
    const res = validateResearch({
      findings: ['not-an-object', null, { title: 'Good', url: 'https://ok.test' }],
    });
    expect(res?.findings).toEqual([{ title: 'Good', url: 'https://ok.test', snippet: '' }]);
  });
});

describe('validateRespondentReportContent — research preservation', () => {
  it('preserves a valid research block through the content validator (read path)', () => {
    const content = validateRespondentReportContent({
      summary: 'Hi',
      sections: [],
      actions: [],
      research: { findings: [{ title: 'S', url: 'https://s.test' }], display: 'table' },
    });
    expect(content?.research).toEqual({
      findings: [{ title: 'S', url: 'https://s.test', snippet: '' }],
      display: 'table',
    });
  });

  it('omits research when the stored content has none', () => {
    const content = validateRespondentReportContent({ summary: 'Hi', sections: [], actions: [] });
    expect(content).not.toHaveProperty('research');
  });
});

describe('validateAppendix', () => {
  it('returns null for non-records, a null/empty body, and the "no appendix" decision', () => {
    expect(validateAppendix(null)).toBeNull();
    expect(validateAppendix('nope')).toBeNull();
    expect(validateAppendix({})).toBeNull();
    expect(validateAppendix({ body: '   ' })).toBeNull();
    expect(validateAppendix({ heading: 'Appendix', body: '' })).toBeNull();
  });

  it('keeps a well-formed appendix and its optional heading', () => {
    expect(validateAppendix({ heading: 'Further context', body: 'Some background.' })).toEqual({
      heading: 'Further context',
      body: 'Some background.',
    });
  });

  it('keeps the body when the heading is missing or empty (renderers default it)', () => {
    expect(validateAppendix({ body: 'Body only.' })).toEqual({ body: 'Body only.' });
    expect(validateAppendix({ heading: '   ', body: 'Body only.' })).toEqual({
      body: 'Body only.',
    });
  });

  it('trims and length-caps the heading and body', () => {
    const res = validateAppendix({
      heading: `  ${'h'.repeat(REPORT_APPENDIX_HEADING_MAX + 20)}  `,
      body: 'b'.repeat(REPORT_APPENDIX_BODY_MAX + 20),
    });
    expect(res?.heading).toHaveLength(REPORT_APPENDIX_HEADING_MAX);
    expect(res?.body).toHaveLength(REPORT_APPENDIX_BODY_MAX);
  });
});

describe('validateRespondentReportContent — appendix preservation', () => {
  it('preserves a valid appendix through the content validator (read path)', () => {
    const content = validateRespondentReportContent({
      summary: 'Hi',
      sections: [],
      actions: [],
      appendix: { heading: 'Appendix', body: 'Extra context.' },
    });
    expect(content?.appendix).toEqual({ heading: 'Appendix', body: 'Extra context.' });
  });

  it('omits the appendix when the stored content has none or it is empty', () => {
    expect(
      validateRespondentReportContent({ summary: 'Hi', sections: [], actions: [] })
    ).not.toHaveProperty('appendix');
    expect(
      validateRespondentReportContent({
        summary: 'Hi',
        sections: [],
        actions: [],
        appendix: { body: '' },
      })
    ).not.toHaveProperty('appendix');
  });
});
