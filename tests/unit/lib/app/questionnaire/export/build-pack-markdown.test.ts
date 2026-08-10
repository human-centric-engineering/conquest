/**
 * build-pack-markdown — unit tests for the Questionnaire Pack Markdown serialiser.
 *
 * Pins: heading levels for each section, GFM tables for setup/data-slots, per-question rendering
 * (prompt/flags/constraint/options/guidance), that excluded (null) sections render nothing, table
 * cells are pipe-escaped, and the closing "About ConQuest" blurb + website link always appear.
 *
 * @see lib/app/questionnaire/export/build-pack-markdown.ts
 */

import { describe, it, expect } from 'vitest';

import { buildPackMarkdown } from '@/lib/app/questionnaire/export/build-pack-markdown';
import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';
import type {
  InstrumentQuestion,
  InstrumentSection,
} from '@/lib/app/questionnaire/export/build-instrument-model';

function question(over: Partial<InstrumentQuestion> = {}): InstrumentQuestion {
  return {
    number: '1.1',
    key: 'q1',
    prompt: 'Sample prompt',
    type: 'free_text',
    typeLabel: 'Free text',
    required: true,
    weight: 0.5,
    guidelines: 'Be concise',
    tags: ['Culture'],
    options: [],
    constraint: null,
    ...over,
  };
}

function section(over: Partial<InstrumentSection> = {}): InstrumentSection {
  return {
    number: 1,
    title: 'Section One',
    description: 'A description',
    questions: [question()],
    ...over,
  };
}

function model(over: Partial<PackModel> = {}): PackModel {
  return {
    title: 'Test Pack',
    versionNumber: 1,
    generatedAt: '2026-08-10T00:00:00.000Z',
    include: { meta: true, questions: true, dataSlots: true, definitions: true, setup: true },
    meta: { goal: 'A goal', audienceSummary: 'Everyone' },
    sections: [section()],
    sectionCount: 1,
    questionCount: 1,
    dataSlots: [
      {
        key: 'ds1',
        name: 'Engagement',
        description: 'Desc',
        theme: 'Culture',
        weight: 1,
        questions: [{ key: 'q1', prompt: 'Sample prompt' }],
      },
    ],
    glossary: {
      heading: 'Definitions',
      entries: [{ term: 'Engagement', definitions: ['Commitment level'] }],
    },
    setup: [{ label: 'Access', value: 'Public link' }],
    ...over,
  };
}

describe('buildPackMarkdown', () => {
  it('renders the title as an H1 and each section as its own H2', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('# Test Pack');
    expect(md).toContain('## Overview');
    expect(md).toContain('## Experience setup');
    expect(md).toContain('## Data slots');
    expect(md).toContain('## Questions');
    expect(md).toContain('## Definitions');
  });

  it('omits a heading entirely when its model field is null', () => {
    const md = buildPackMarkdown(
      model({ meta: null, dataSlots: null, glossary: null, setup: null })
    );
    expect(md).not.toContain('## Overview');
    expect(md).not.toContain('## Data slots');
    expect(md).not.toContain('## Definitions');
    expect(md).not.toContain('## Experience setup');
    expect(md).toContain('## Questions');
  });

  it('renders the experience-setup summary as a GFM table', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('| Setting | Value |');
    expect(md).toContain('| Access | Public link |');
  });

  it('renders data slots as a table with pipe-joined linked-question prompts', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('| Engagement | Culture | Desc | Sample prompt |');
  });

  it('escapes a literal pipe character inside a table cell', () => {
    const md = buildPackMarkdown(
      model({
        dataSlots: [
          { key: 'ds1', name: 'A | B', description: 'x', theme: 'y', weight: 1, questions: [] },
        ],
      })
    );
    expect(md).toContain('A \\| B');
  });

  it('renders each section as an H3 with its numbered questions', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('### 1. Section One');
    expect(md).toContain('**1.1. Sample prompt**');
    expect(md).toContain('_(Free text, required)_');
  });

  it('renders question options, constraint, and guidance as bullets', () => {
    const md = buildPackMarkdown(
      model({
        sections: [
          section({
            questions: [
              question({
                options: ['Red', 'Blue'],
                constraint: 'Pick one',
                guidelines: 'Think carefully',
              }),
            ],
          }),
        ],
      })
    );
    expect(md).toContain('- Pick one');
    expect(md).toContain('- Red');
    expect(md).toContain('- Blue');
    expect(md).toContain('- Guidance: Think carefully');
  });

  it('renders the definitions appendix under the glossary heading', () => {
    const md = buildPackMarkdown(model());
    expect(md).toContain('**Engagement**');
    expect(md).toContain(': Commitment level');
  });

  it('numbers multiple definitions for the same term', () => {
    const md = buildPackMarkdown(
      model({
        glossary: {
          heading: 'Definitions',
          entries: [{ term: 'Engagement', definitions: ['Sense one', 'Sense two'] }],
        },
      })
    );
    expect(md).toContain('1. Sense one');
    expect(md).toContain('2. Sense two');
  });

  it('always renders the closing "About ConQuest" blurb and website link', () => {
    const md = buildPackMarkdown(
      model({ meta: null, dataSlots: null, glossary: null, setup: null, sections: null })
    );
    expect(md).toContain(`## ${PACK_BRAND.closingHeading}`);
    expect(md).toContain(PACK_BRAND.closingBlurb);
    expect(md).toContain(`https://${PACK_BRAND.website}`);
  });

  it('ends with a single trailing newline', () => {
    const md = buildPackMarkdown(model());
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});
