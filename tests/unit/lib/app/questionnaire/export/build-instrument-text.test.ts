/**
 * build-instrument-text — unit tests for the blank-instrument plain-text serialiser (F14.9).
 *
 * Pins: header block layout (title, subtitle, version always present, goal/audience/generated
 * omitted when null, sections·questions counter always present, 60-char rule separator),
 * degraded output for an empty instrument, section heading format ("N. Title"), section
 * description (trimmed when present, omitted when null), "(no questions)" for empty sections,
 * question line format ("  N.M  prompt  [typeLabel, required/optional]"), constraint indentation,
 * option bullet points, guidance prefix, tags line, and the single trailing newline invariant.
 *
 * Pure: buildInstrumentText has no I/O or external dependencies — no mocking needed.
 *
 * @see lib/app/questionnaire/export/build-instrument-text.ts
 */

import { describe, it, expect } from 'vitest';

import { buildInstrumentText } from '@/lib/app/questionnaire/export/build-instrument-text';
import type {
  InstrumentModel,
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

// ─── fixtures ────────────────────────────────────────────────────────────────

function question(over: Partial<InstrumentQuestion> = {}): InstrumentQuestion {
  return {
    number: '1.1',
    key: 'q1',
    prompt: 'Sample prompt',
    type: 'free_text',
    typeLabel: 'Free text',
    required: false,
    weight: 0.5,
    guidelines: null,
    tags: [],
    options: [],
    constraint: null,
    ...over,
  };
}

function section(over: Partial<InstrumentSection> = {}): InstrumentSection {
  return {
    number: 1,
    title: 'Section One',
    description: null,
    questions: [question()],
    ...over,
  };
}

function model(over: Partial<InstrumentModel> = {}): InstrumentModel {
  return {
    title: 'Test Questionnaire',
    versionNumber: 1,
    goal: null,
    audienceSummary: null,
    generatedAt: '2026-06-28T00:00:00.000Z',
    sectionCount: 1,
    questionCount: 1,
    sections: [section()],
    ...over,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('buildInstrumentText', () => {
  describe('header block', () => {
    it('opens with the questionnaire title on the first line', () => {
      const txt = buildInstrumentText(model({ title: 'My Questionnaire' }));
      expect(txt.startsWith('My Questionnaire\n')).toBe(true);
    });

    it('places "Questionnaire (blank form)" on the second line', () => {
      const lines = buildInstrumentText(model()).split('\n');
      expect(lines[1]).toBe('Questionnaire (blank form)');
    });

    it('always includes the Version line even for version 0', () => {
      const txt = buildInstrumentText(model({ versionNumber: 0 }));
      expect(txt).toContain('Version: 0');
    });

    it('includes Goal when the model has a goal', () => {
      const txt = buildInstrumentText(model({ goal: 'Understand team morale' }));
      expect(txt).toContain('Goal: Understand team morale');
    });

    it('omits the Goal line when goal is null', () => {
      const txt = buildInstrumentText(model({ goal: null }));
      expect(txt).not.toContain('Goal:');
    });

    it('includes Audience when audienceSummary is set', () => {
      const txt = buildInstrumentText(model({ audienceSummary: 'All staff' }));
      expect(txt).toContain('Audience: All staff');
    });

    it('omits the Audience line when audienceSummary is null', () => {
      const txt = buildInstrumentText(model({ audienceSummary: null }));
      expect(txt).not.toContain('Audience:');
    });

    it('always includes the Sections · Questions count line', () => {
      const txt = buildInstrumentText(model({ sectionCount: 3, questionCount: 12 }));
      expect(txt).toContain('Sections: 3 · Questions: 12');
    });

    it('includes the Generated line when generatedAt is non-empty', () => {
      const txt = buildInstrumentText(model({ generatedAt: '2026-06-28T00:00:00.000Z' }));
      expect(txt).toContain('Generated: 2026-06-28T00:00:00.000Z');
    });

    it('includes the 60-character horizontal rule separator', () => {
      const txt = buildInstrumentText(model());
      expect(txt).toContain('─'.repeat(60));
    });
  });

  describe('empty instrument', () => {
    it('renders a "no sections yet" message when the sections array is empty', () => {
      const txt = buildInstrumentText(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      expect(txt).toContain('This questionnaire has no sections yet.');
    });

    it('does not emit any section-heading line when there are no sections', () => {
      const txt = buildInstrumentText(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      // A section heading matches "N. Title" — no digit-dot pattern should appear
      expect(txt).not.toMatch(/^\d+\. /m);
    });
  });

  describe('section headings', () => {
    it('renders a section heading as "N. Title"', () => {
      const txt = buildInstrumentText(
        model({ sections: [section({ number: 2, title: 'Background' })] })
      );
      expect(txt).toContain('2. Background');
    });

    it('includes the section description when present', () => {
      const txt = buildInstrumentText(
        model({ sections: [section({ description: 'Tell us about yourself' })] })
      );
      expect(txt).toContain('Tell us about yourself');
    });

    it('omits the description block entirely when description is null', () => {
      const txt = buildInstrumentText(model({ sections: [section({ description: null })] }));
      const lines = txt.split('\n');
      const headingIdx = lines.findIndex((l) => l === '1. Section One');
      expect(headingIdx).toBeGreaterThan(-1);
      // With no description, the heading is followed immediately by a blank line then the question —
      // no description text or extra blank line inserted in between
      expect(lines[headingIdx + 1]).toBe('');
      expect(lines[headingIdx + 2]).toBe('  1.1  Sample prompt  [Free text, optional]');
    });

    it('trims surrounding whitespace from the section description before rendering', () => {
      const txt = buildInstrumentText(
        model({ sections: [section({ description: '  About you  ' })] })
      );
      expect(txt).toContain('About you');
      expect(txt).not.toContain('  About you  ');
    });

    it('renders "(no questions)" indented when a section has no questions', () => {
      const txt = buildInstrumentText(
        model({ sections: [section({ questions: [] })], questionCount: 0 })
      );
      expect(txt).toContain('  (no questions)');
    });
  });

  describe('question lines', () => {
    it('renders each question as "  {number}  {prompt}  [{typeLabel}, required]" when required', () => {
      const q = question({
        number: '1.1',
        prompt: 'What is your age?',
        typeLabel: 'Numeric',
        required: true,
      });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('  1.1  What is your age?  [Numeric, required]');
    });

    it('marks non-required questions as "optional" in the type bracket', () => {
      const q = question({
        number: '1.1',
        prompt: 'Anything else?',
        typeLabel: 'Free text',
        required: false,
      });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('  1.1  Anything else?  [Free text, optional]');
    });

    it('renders the constraint on its own indented line below the question', () => {
      const q = question({ constraint: 'Numeric (min 0, max 120)' });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('      Numeric (min 0, max 120)');
    });

    it('omits the constraint line when constraint is null', () => {
      const q = question({ constraint: null });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      const lines = txt.split('\n');
      const questionLineIdx = lines.findIndex(
        (l) => l === '  1.1  Sample prompt  [Free text, optional]'
      );
      expect(questionLineIdx).toBeGreaterThan(-1);
      // With no constraint, options, guidelines, or tags, the question line is followed
      // immediately by a blank line — not an indented constraint line (6-space prefix)
      expect(lines[questionLineIdx + 1]).toBe('');
    });

    it('renders each option as an indented bullet "      • option"', () => {
      const q = question({ options: ['Option A', 'Option B'] });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('      • Option A');
      expect(txt).toContain('      • Option B');
    });

    it('renders no bullet points when options is empty', () => {
      const q = question({ options: [] });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).not.toContain('•');
    });

    it('renders guidelines with the "Guidance: " prefix on an indented line', () => {
      const q = question({ guidelines: 'Be specific and honest' });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('      Guidance: Be specific and honest');
    });

    it('omits the Guidance line when guidelines is null', () => {
      const q = question({ guidelines: null });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).not.toContain('Guidance:');
    });

    it('trims surrounding whitespace from guidelines before rendering', () => {
      const q = question({ guidelines: '  Consider all options  ' });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('Guidance: Consider all options');
      expect(txt).not.toContain('Guidance:   Consider all options');
    });

    it('renders a Tags line with comma-joined tags when the question has tags', () => {
      const q = question({ tags: ['Wellbeing', 'Culture'] });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('      Tags: Wellbeing, Culture');
    });

    it('omits the Tags line when the tags array is empty', () => {
      const q = question({ tags: [] });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).not.toContain('Tags:');
    });

    it('renders a single tag without a trailing comma', () => {
      const q = question({ tags: ['Wellbeing'] });
      const txt = buildInstrumentText(model({ sections: [section({ questions: [q] })] }));
      expect(txt).toContain('      Tags: Wellbeing');
      expect(txt).not.toContain('Tags: Wellbeing,');
    });
  });

  describe('trailing newline invariant', () => {
    it('ends with exactly one trailing newline for a populated instrument', () => {
      const txt = buildInstrumentText(model());
      expect(txt.endsWith('\n')).toBe(true);
      expect(txt.endsWith('\n\n')).toBe(false);
    });

    it('ends with exactly one trailing newline for an empty-sections instrument', () => {
      const txt = buildInstrumentText(model({ sections: [], sectionCount: 0, questionCount: 0 }));
      expect(txt.endsWith('\n')).toBe(true);
      expect(txt.endsWith('\n\n')).toBe(false);
    });

    it('ends with exactly one trailing newline for a section with no questions', () => {
      const txt = buildInstrumentText(
        model({ sections: [section({ questions: [] })], questionCount: 0 })
      );
      expect(txt.endsWith('\n')).toBe(true);
      expect(txt.endsWith('\n\n')).toBe(false);
    });
  });

  describe('multi-section output order', () => {
    it('renders sections in ascending section-number order', () => {
      const txt = buildInstrumentText(
        model({
          sectionCount: 2,
          questionCount: 2,
          sections: [
            section({
              number: 1,
              title: 'First Section',
              questions: [question({ number: '1.1', prompt: 'Q in first' })],
            }),
            section({
              number: 2,
              title: 'Second Section',
              questions: [question({ key: 'q2', number: '2.1', prompt: 'Q in second' })],
            }),
          ],
        })
      );
      expect(txt.indexOf('1. First Section')).toBeLessThan(txt.indexOf('2. Second Section'));
    });

    it('renders questions from section 1 before questions from section 2', () => {
      const txt = buildInstrumentText(
        model({
          sectionCount: 2,
          questionCount: 2,
          sections: [
            section({
              number: 1,
              title: 'First',
              questions: [question({ number: '1.1', prompt: 'Alpha question' })],
            }),
            section({
              number: 2,
              title: 'Second',
              questions: [question({ key: 'q2', number: '2.1', prompt: 'Beta question' })],
            }),
          ],
        })
      );
      expect(txt.indexOf('Alpha question')).toBeLessThan(txt.indexOf('Beta question'));
    });
  });

  describe('full document layout', () => {
    it('renders a complete instrument with all optional fields in the expected block order', () => {
      const txt = buildInstrumentText({
        title: 'Staff Survey',
        versionNumber: 2,
        goal: 'Measure satisfaction',
        audienceSummary: 'All staff',
        generatedAt: '2026-06-28',
        sectionCount: 1,
        questionCount: 1,
        sections: [
          {
            number: 1,
            title: 'Overview',
            description: 'General questions',
            questions: [
              {
                number: '1.1',
                key: 'overall',
                prompt: 'Rate your satisfaction',
                type: 'likert',
                typeLabel: 'Likert',
                required: true,
                weight: 1,
                guidelines: 'Be honest',
                tags: ['Engagement'],
                options: ['1 — Low', '2 — High'],
                constraint: 'Scale 1 (Low) to 2 (High)',
              },
            ],
          },
        ],
      });

      // Header block
      expect(txt).toContain('Staff Survey');
      expect(txt).toContain('Questionnaire (blank form)');
      expect(txt).toContain('Version: 2');
      expect(txt).toContain('Goal: Measure satisfaction');
      expect(txt).toContain('Audience: All staff');
      expect(txt).toContain('Sections: 1 · Questions: 1');
      expect(txt).toContain('Generated: 2026-06-28');

      // Separator
      expect(txt).toContain('─'.repeat(60));

      // Section and question
      expect(txt).toContain('1. Overview');
      expect(txt).toContain('General questions');
      expect(txt).toContain('  1.1  Rate your satisfaction  [Likert, required]');
      expect(txt).toContain('      Scale 1 (Low) to 2 (High)');
      expect(txt).toContain('      • 1 — Low');
      expect(txt).toContain('      • 2 — High');
      expect(txt).toContain('      Guidance: Be honest');
      expect(txt).toContain('      Tags: Engagement');

      // Header block must appear before the section
      expect(txt.indexOf('Version: 2')).toBeLessThan(txt.indexOf('1. Overview'));
      // Rule must appear between header and sections
      expect(txt.indexOf('─'.repeat(60))).toBeLessThan(txt.indexOf('1. Overview'));
    });
  });
});
