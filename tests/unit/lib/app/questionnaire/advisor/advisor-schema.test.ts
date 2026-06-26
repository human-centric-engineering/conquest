/**
 * Unit test for the Config Advisor analysis schema (`advisor-schema.ts`).
 *
 * `validateAdvisorAnalysis` is the boundary that turns the model's free JSON into the structured
 * analysis the panel renders + applies. These tests pin its normalisation: it keeps only applyable
 * patch keys, drops suggestions left with an empty patch, mints stable ids, and rejects structurally
 * malformed input (so `runStructuredCompletion` retries).
 */

import { describe, it, expect } from 'vitest';

import {
  validateAdvisorAnalysis,
  ADVISOR_APPLYABLE_CONFIG_FIELDS,
} from '@/lib/app/questionnaire/advisor/advisor-schema';

describe('validateAdvisorAnalysis', () => {
  it('returns conflicts and suggestions on a well-formed payload', () => {
    const result = validateAdvisorAnalysis({
      conflicts: [
        {
          title: 'Adaptive with a 1-question cap',
          detail: 'Adaptive selection needs room to adapt.',
          settings: ['selectionStrategy', 'maxQuestionsPerSession'],
          severity: 'warning',
        },
      ],
      suggestions: [
        {
          id: 'raise-cap',
          title: 'Raise the per-session cap',
          rationale: 'So adaptive selection has room to work.',
          severity: 'warning',
          patch: { maxQuestionsPerSession: 10 },
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.conflicts).toHaveLength(1);
    expect(result?.suggestions).toHaveLength(1);
    expect(result?.suggestions[0]).toMatchObject({
      id: 'raise-cap',
      patch: { maxQuestionsPerSession: 10 },
    });
  });

  it('strips non-applyable patch keys, keeping the applyable ones', () => {
    const result = validateAdvisorAnalysis({
      conflicts: [],
      suggestions: [
        {
          title: 'Mixed patch',
          rationale: 'r',
          severity: 'info',
          // `tone` is NOT applyable (structured block); `voiceEnabled` is.
          patch: { tone: { persona: 'x' }, voiceEnabled: true },
        },
      ],
    });

    expect(result?.suggestions).toHaveLength(1);
    expect(result?.suggestions[0].patch).toEqual({ voiceEnabled: true });
    expect(result?.suggestions[0].patch).not.toHaveProperty('tone');
  });

  it('drops a suggestion whose patch has no applyable key (prose-only advice)', () => {
    const result = validateAdvisorAnalysis({
      conflicts: [],
      suggestions: [
        {
          title: 'Only non-applyable',
          rationale: 'r',
          severity: 'info',
          patch: { respondentReport: { mode: 'raw' }, somethingInvented: 1 },
        },
      ],
    });

    expect(result?.suggestions).toHaveLength(0);
  });

  it('mints a stable id when the model omits one', () => {
    const result = validateAdvisorAnalysis({
      conflicts: [],
      suggestions: [
        { title: 'A', rationale: 'r', severity: 'info', patch: { voiceEnabled: false } },
        { title: 'B', rationale: 'r', severity: 'info', patch: { attachmentsEnabled: false } },
      ],
    });

    const ids = result?.suggestions.map((s) => s.id) ?? [];
    expect(ids).toEqual(['suggestion-1', 'suggestion-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('de-duplicates model-supplied ids so each suggestion keeps a unique id', () => {
    // The client keys React list + apply state by id; a model emitting the same id twice would
    // collapse two suggestions into one. The second collision must be re-minted to a unique id.
    const result = validateAdvisorAnalysis({
      conflicts: [],
      suggestions: [
        { id: 'dup', title: 'A', rationale: 'r', severity: 'info', patch: { voiceEnabled: false } },
        {
          id: 'dup',
          title: 'B',
          rationale: 'r',
          severity: 'info',
          patch: { attachmentsEnabled: false },
        },
      ],
    });

    const ids = result?.suggestions.map((s) => s.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // both unique
    expect(ids[0]).toBe('dup'); // first occurrence keeps the model id
  });

  it('defaults missing conflicts/suggestions arrays to empty', () => {
    const result = validateAdvisorAnalysis({});
    expect(result).toEqual({ conflicts: [], suggestions: [] });
  });

  it('returns null when severity is not a known enum value', () => {
    const result = validateAdvisorAnalysis({
      conflicts: [],
      suggestions: [
        { title: 'A', rationale: 'r', severity: 'catastrophic', patch: { voiceEnabled: true } },
      ],
    });
    expect(result).toBeNull();
  });

  it('returns null on a structurally invalid payload (non-object)', () => {
    expect(validateAdvisorAnalysis('nope')).toBeNull();
    expect(validateAdvisorAnalysis(null)).toBeNull();
  });

  it('every applyable field is a real config key (allowlist sanity)', () => {
    // Guards against a typo in the allowlist tuple; mirrors the `satisfies` compile guard at runtime.
    expect(ADVISOR_APPLYABLE_CONFIG_FIELDS).toContain('selectionStrategy');
    expect(ADVISOR_APPLYABLE_CONFIG_FIELDS).toContain('accessMode');
    // Structured blocks must NOT be applyable.
    expect(ADVISOR_APPLYABLE_CONFIG_FIELDS).not.toContain('tone');
    expect(ADVISOR_APPLYABLE_CONFIG_FIELDS).not.toContain('profileFields');
  });
});
