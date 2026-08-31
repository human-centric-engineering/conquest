/**
 * Unit tests: the contrast optimiser's shared contract.
 *
 * `OPTIMISABLE_FIELDS` and `CONTRAST_PAIRS` are consumed as compile-time types everywhere else in
 * this module (`audit.ts`'s `PairSpec.id` and `MovableColor.field`), so nothing else in the test
 * suite calls `isOptimisableField` at runtime — it is exercised only here, directly, the same way
 * the sibling `isImportableColorField` earns its own assertion in brand-import.
 *
 * @see lib/app/questionnaire/brand-contrast/result.ts
 */

import { describe, it, expect } from 'vitest';

import {
  OPTIMISABLE_FIELDS,
  isOptimisableField,
} from '@/lib/app/questionnaire/brand-contrast/result';

describe('isOptimisableField', () => {
  it('accepts every field the optimiser may propose a value for', () => {
    for (const field of OPTIMISABLE_FIELDS) {
      expect(isOptimisableField(field)).toBe(true);
    }
  });

  it('rejects a theme field the optimiser never touches', () => {
    // `logoBackgroundColor` is the documented omission — what sits on it is an image, and no ratio
    // says whether a lockup reads on a backdrop.
    expect(isOptimisableField('logoBackgroundColor')).toBe(false);
    expect(isOptimisableField('logoUrl')).toBe(false);
  });

  it('rejects an arbitrary string', () => {
    expect(isOptimisableField('notAField')).toBe(false);
  });
});
