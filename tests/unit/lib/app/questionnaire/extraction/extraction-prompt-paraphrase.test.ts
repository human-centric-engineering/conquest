/**
 * Unit tests: the answer-extraction prompt instructs free-text paraphrasing (with significant
 * quotes + living accumulation), and renders the comment-aggregation mode + current summary per
 * free-text candidate.
 */

import { describe, it, expect } from 'vitest';

import { buildAnswerExtractionPrompt } from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { ctx, slot } from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

function allText(messages: { content: unknown }[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('buildAnswerExtractionPrompt — free-text paraphrase rules', () => {
  it('the system rules describe a paraphrase with significant verbatim in quotes that builds up', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'comments', type: 'free_text' })] })
    );
    const text = allText(messages);
    expect(text).toMatch(/"paraphrase"/);
    expect(text).toMatch(/NOTABLE or IMPACTFUL/);
    expect(text).toMatch(/quotes/i);
    expect(text).toMatch(/LIVING summary/);
  });

  it('renders the section-summary mode + current summary for a section-aggregating comment field', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [
          // Built inline (not via `slot()`, which doesn't carry `currentParaphrase`).
          {
            key: 'comments',
            sectionId: 's1',
            type: 'free_text',
            typeConfig: { commentAggregation: 'section' },
            prompt: 'Please provide comments to support your scores.',
            required: false,
            currentParaphrase: 'They describe guidance as "ad hoc".',
          },
        ],
      })
    );
    const text = allText(messages);
    expect(text).toMatch(/SECTION SUMMARY/);
    expect(text).toContain('current summary: They describe guidance as "ad hoc".');
  });

  it('marks an isolated free-text field accordingly', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'role', type: 'free_text' })] })
    );
    expect(allText(messages)).toMatch(/comment: isolated/);
  });
});
