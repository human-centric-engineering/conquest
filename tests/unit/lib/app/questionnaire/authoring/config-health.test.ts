import { describe, it, expect } from 'vitest';

import { questionConfigIssue } from '@/lib/app/questionnaire/authoring/config-health';
import { defaultTypeConfig } from '@/lib/app/questionnaire/authoring/type-config-schema';

/**
 * The structure editor's "this question isn't ready" cue (F2.1 / PR2).
 *
 * `questionConfigIssue` must agree with the write-side `validateTypeConfig` on
 * pass/fail (a valid config → no cue) and pick the most specific message for the
 * common failures — above all the two likert gaps the admin needs flagged:
 * a missing/invalid range vs missing per-point labels.
 */
describe('questionConfigIssue — clean configs surface nothing', () => {
  it('returns null for a fully-labelled likert default', () => {
    expect(questionConfigIssue('likert', defaultTypeConfig('likert'))).toBeNull();
  });

  it('returns null for a valid choice config', () => {
    expect(questionConfigIssue('single_choice', defaultTypeConfig('single_choice'))).toBeNull();
  });

  it.each(['free_text', 'date', 'boolean', 'numeric'] as const)(
    'returns null for config-less / config-optional type %s',
    (type) => {
      expect(questionConfigIssue(type, defaultTypeConfig(type))).toBeNull();
    }
  );

  it('returns null for a coherent numeric range', () => {
    expect(questionConfigIssue('numeric', { min: 0, max: 10 })).toBeNull();
  });

  // The DB stores config-less / config-optional types as JSON null — these need no
  // setup and must not be flagged (regression: a null boolean read as "Needs setup").
  it.each(['boolean', 'numeric', 'free_text', 'date'] as const)(
    'returns null when config-optional type %s has a null config',
    (type) => {
      expect(questionConfigIssue(type, null)).toBeNull();
    }
  );

  it.each(['boolean', 'numeric', 'free_text', 'date'] as const)(
    'returns null when config-optional type %s has an undefined config',
    (type) => {
      expect(questionConfigIssue(type, undefined)).toBeNull();
    }
  );

  // Required-config types must still flag an absent config.
  it.each(['likert', 'single_choice', 'multi_choice'] as const)(
    'still flags required-config type %s when config is null',
    (type) => {
      expect(questionConfigIssue(type, null)).not.toBeNull();
    }
  );

  // Regression: the extractor tags free_text fields with commentAggregation
  // (extraction-prompt.ts). That is a valid config and must NOT surface a cue —
  // previously it tripped a spurious "Check config" on every tagged field.
  it.each(['isolated', 'section'] as const)(
    'returns null for a free_text with commentAggregation=%s',
    (mode) => {
      expect(questionConfigIssue('free_text', { commentAggregation: mode })).toBeNull();
    }
  );
});

describe('questionConfigIssue — likert gaps', () => {
  it('flags a missing range before labels', () => {
    const issue = questionConfigIssue('likert', { labels: [] });
    expect(issue?.label).toBe('Set scale range');
  });

  it('flags an incoherent range (max ≤ min)', () => {
    const issue = questionConfigIssue('likert', { min: 5, max: 5, labels: ['a'] });
    expect(issue?.label).toBe('Set scale range');
  });

  it('flags missing labels once the range is valid', () => {
    const issue = questionConfigIssue('likert', { min: 1, max: 5 });
    expect(issue?.label).toBe('Add scale labels');
  });

  it('flags an incomplete label set (one per point required)', () => {
    const issue = questionConfigIssue('likert', { min: 1, max: 3, labels: ['low', '', 'high'] });
    expect(issue?.label).toBe('Add scale labels');
  });
});

describe('questionConfigIssue — other types', () => {
  it('flags a choice question with fewer than two options', () => {
    const issue = questionConfigIssue('single_choice', { choices: [{ value: 'a', label: 'A' }] });
    expect(issue?.label).toBe('Add options');
  });

  it('flags a choice question with blank / duplicate options', () => {
    const issue = questionConfigIssue('multi_choice', {
      choices: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'B' },
      ],
    });
    expect(issue?.label).toBe('Fix options');
  });

  it('flags an incoherent numeric range', () => {
    const issue = questionConfigIssue('numeric', { min: 10, max: 0 });
    expect(issue?.label).toBe('Fix range');
  });

  // A non-range numeric failure (step ≤ 0) must NOT claim a range problem — the
  // bounds are fine, so "Fix range" would misdirect the admin.
  it('flags a non-range numeric failure without the range message', () => {
    const issue = questionConfigIssue('numeric', { min: 0, max: 10, step: 0 });
    expect(issue?.label).toBe('Fix numeric setup');
    expect(issue?.detail).not.toMatch(/maximum must be/i);
  });

  // A boolean with a present-but-blank custom label fails validation; it must get
  // boolean-appropriate copy, not the generic choice-flavoured fallback.
  it('flags a boolean with a blank custom label', () => {
    const issue = questionConfigIssue('boolean', { trueLabel: '' });
    expect(issue?.label).toBe('Label answers');
  });

  // A config-less type carrying leftover config hits the default arm — its copy
  // must be type-agnostic (no "answer options" choice terminology).
  it('flags a config-less type with leftover config via the default arm', () => {
    const issue = questionConfigIssue('free_text', { stray: 'config' });
    expect(issue?.label).toBe('Check config');
    expect(issue?.detail).not.toMatch(/answer options/i);
  });

  it('carries the exact admin-facing detail sentence alongside the chip label', () => {
    const issue = questionConfigIssue('likert', { min: 1, max: 5 });
    expect(issue?.label).toBe('Add scale labels');
    expect(issue?.detail).toBe(
      'Label every point on this rating scale (e.g. 1 = “Very dissatisfied”), or switch the type to Numeric for an unlabelled rating.'
    );
  });

  // Schema drift: a stored type outside the current union has no config contract
  // to check — return null rather than throwing on its absent write schema.
  it('returns null (does not throw) for an unrecognised type', () => {
    expect(() =>
      // @ts-expect-error — simulating a legacy/unknown stored type value.
      questionConfigIssue('matrix', { some: 'config' })
    ).not.toThrow();
    // @ts-expect-error — same unknown type, assert the null result.
    expect(questionConfigIssue('matrix', { some: 'config' })).toBeNull();
  });
});
