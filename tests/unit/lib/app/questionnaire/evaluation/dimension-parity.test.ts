import { describe, expect, it } from 'vitest';

import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  EVALUATION_JUDGE_SLUGS,
  dimensionForSlug,
} from '@/lib/app/questionnaire/evaluation';

describe('evaluation dimension registry parity', () => {
  it('declares exactly seven distinct dimensions', () => {
    expect(EVALUATION_DIMENSIONS).toHaveLength(7);
    expect(new Set(EVALUATION_DIMENSIONS).size).toBe(7);
  });

  it('has a spec for every dimension with a unique, app-namespaced slug', () => {
    const slugs = new Set<string>();
    for (const dimension of EVALUATION_DIMENSIONS) {
      const spec = EVALUATION_DIMENSION_SPECS[dimension];
      expect(spec).toBeDefined();
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.slug).toMatch(/^app-questionnaire-judge-[a-z-]+$/);
      slugs.add(spec.slug);
    }
    expect(slugs.size).toBe(7);
  });

  it('EVALUATION_JUDGE_SLUGS lists the spec slugs in dimension order', () => {
    expect(EVALUATION_JUDGE_SLUGS).toEqual(
      EVALUATION_DIMENSIONS.map((d) => EVALUATION_DIMENSION_SPECS[d].slug)
    );
  });

  it('dimensionForSlug round-trips every slug and rejects unknown ones', () => {
    for (const dimension of EVALUATION_DIMENSIONS) {
      expect(dimensionForSlug(EVALUATION_DIMENSION_SPECS[dimension].slug)).toBe(dimension);
    }
    expect(dimensionForSlug('not-a-judge')).toBeUndefined();
  });
});
