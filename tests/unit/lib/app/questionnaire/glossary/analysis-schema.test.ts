/**
 * Glossary Analyst structured-output contract — unit tests (P16).
 *
 * This schema is the boundary between an LLM's free-form output and rows we persist, so the
 * caps and required fields are what stop a runaway or half-formed proposal reaching the admin's
 * review queue.
 *
 * @see lib/app/questionnaire/glossary/analysis-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  GLOSSARY_ANALYSIS_MAX_TERMS,
  glossaryAnalysisSchema,
  validateGlossaryAnalysis,
} from '@/lib/app/questionnaire/glossary/analysis-schema';
import { GLOSSARY_MAX_DEFINITIONS_PER_TERM } from '@/lib/app/questionnaire/glossary/types';

function term(overrides: Record<string, unknown> = {}) {
  return {
    term: 'higher self',
    rationale: 'Means different things across traditions.',
    definitions: [{ text: 'The observing, values-led part of you.' }],
    ...overrides,
  };
}

describe('glossaryAnalysisSchema', () => {
  it('parses a well-formed proposal, defaulting aliases to empty', () => {
    const parsed = glossaryAnalysisSchema.parse({ terms: [term()] });
    expect(parsed.terms[0]).toMatchObject({ term: 'higher self', aliases: [] });
  });

  it('accepts an empty proposal — "nothing here is ambiguous" is a real answer', () => {
    expect(glossaryAnalysisSchema.safeParse({ terms: [] }).success).toBe(true);
  });

  it('keeps a sourceQuote when the analyst drew a definition from the document', () => {
    const parsed = glossaryAnalysisSchema.parse({
      terms: [
        term({
          definitions: [{ text: 'The Self that observes.', sourceQuote: 'the Self that observes' }],
        }),
      ],
    });
    expect(parsed.terms[0].definitions[0].sourceQuote).toBe('the Self that observes');
  });

  it('rejects a term with no definitions — a proposal with no reading is a complaint', () => {
    expect(glossaryAnalysisSchema.safeParse({ terms: [term({ definitions: [] })] }).success).toBe(
      false
    );
  });

  it('rejects a term with no rationale — the admin needs the "why" to adjudicate', () => {
    const result = glossaryAnalysisSchema.safeParse({ terms: [term({ rationale: '' })] });
    expect(result.success).toBe(false);
  });

  it('caps definitions per term', () => {
    const many = Array.from({ length: GLOSSARY_MAX_DEFINITIONS_PER_TERM + 1 }, (_, i) => ({
      text: `sense ${i}`,
    }));
    expect(glossaryAnalysisSchema.safeParse({ terms: [term({ definitions: many })] }).success).toBe(
      false
    );
  });

  it('caps the number of proposed terms', () => {
    const build = (count: number) => ({
      terms: Array.from({ length: count }, (_, i) => term({ term: `term ${i}` })),
    });
    expect(glossaryAnalysisSchema.safeParse(build(GLOSSARY_ANALYSIS_MAX_TERMS)).success).toBe(true);
    expect(glossaryAnalysisSchema.safeParse(build(GLOSSARY_ANALYSIS_MAX_TERMS + 1)).success).toBe(
      false
    );
  });

  it('caps aliases at eight', () => {
    const aliases = Array.from({ length: 9 }, (_, i) => `alias${i}`);
    expect(glossaryAnalysisSchema.safeParse({ terms: [term({ aliases })] }).success).toBe(false);
  });

  it('strips keys the analyst invented rather than passing them through', () => {
    const parsed = glossaryAnalysisSchema.parse({
      terms: [term({ confidence: 0.9, severity: 'high' })],
    });
    expect(parsed.terms[0]).not.toHaveProperty('confidence');
    expect(parsed.terms[0]).not.toHaveProperty('severity');
  });
});

describe('validateGlossaryAnalysis', () => {
  it('returns the validated value on success', () => {
    const result = validateGlossaryAnalysis({ terms: [term()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.terms).toHaveLength(1);
  });

  it('returns issue paths on failure so the retry can name what was wrong', () => {
    const result = validateGlossaryAnalysis({ terms: [term({ definitions: [] })] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].path.join('.')).toContain('definitions');
  });

  it('fails on a non-object rather than throwing', () => {
    expect(validateGlossaryAnalysis('not json').ok).toBe(false);
    expect(validateGlossaryAnalysis(null).ok).toBe(false);
  });
});
