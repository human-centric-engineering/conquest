import { describe, expect, it } from 'vitest';

import {
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  SCOPE_EVALUATION_JUDGE_SLUGS,
  scopeDimensionForSlug,
} from '@/lib/app/questionnaire/scope-evaluation';

describe('scope-evaluation dimension registry parity', () => {
  it('declares exactly three distinct dimensions', () => {
    expect(SCOPE_EVALUATION_DIMENSIONS).toHaveLength(3);
    expect(new Set(SCOPE_EVALUATION_DIMENSIONS).size).toBe(3);
  });

  it('has a spec for every dimension with a unique, app-namespaced slug', () => {
    const slugs = new Set<string>();
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const spec = SCOPE_EVALUATION_DIMENSION_SPECS[dimension];
      expect(spec).toBeDefined();
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.slug).toMatch(/^app-questionnaire-scope-judge-[a-z-]+$/);
      slugs.add(spec.slug);
    }
    expect(slugs.size).toBe(3);
  });

  it('SCOPE_EVALUATION_JUDGE_SLUGS lists the spec slugs in dimension order', () => {
    expect(SCOPE_EVALUATION_JUDGE_SLUGS).toEqual(
      SCOPE_EVALUATION_DIMENSIONS.map((d) => SCOPE_EVALUATION_DIMENSION_SPECS[d].slug)
    );
  });

  it('scopeDimensionForSlug round-trips every slug and rejects unknown ones', () => {
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      expect(scopeDimensionForSlug(SCOPE_EVALUATION_DIMENSION_SPECS[dimension].slug)).toBe(
        dimension
      );
    }
    expect(scopeDimensionForSlug('not-a-judge')).toBeUndefined();
  });
});
