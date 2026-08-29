/**
 * Unit tests: brand-import contrast annotation.
 *
 * The rule under test is a product decision as much as a numeric one: an unreadable pair is
 * flagged, never corrected and never rejected, because a brand can legitimately be low-contrast
 * and refusing the import would be us overruling the client's designer.
 */

import { describe, it, expect } from 'vitest';

import { annotateContrast } from '@/lib/app/questionnaire/brand-import/contrast';
import type { ProposedField } from '@/lib/app/questionnaire/brand-import/result';

const field = (value: string): ProposedField => ({
  value,
  confidence: 'high',
  source: 'read from the screenshot',
});

describe('annotateContrast', () => {
  it('adds a caveat to both halves of an unreadable pair', () => {
    const annotated = annotateContrast({
      canvasColor: field('#8a8a8a'),
      inkColor: field('#9a9a9a'),
    });

    expect(annotated.canvasColor?.caveat).toContain('below the WCAG AA threshold');
    expect(annotated.inkColor?.caveat).toBe(annotated.canvasColor?.caveat);
  });

  it('never changes the proposed values — it annotates, it does not correct', () => {
    const annotated = annotateContrast({
      canvasColor: field('#8a8a8a'),
      inkColor: field('#9a9a9a'),
    });

    expect(annotated.canvasColor?.value).toBe('#8a8a8a');
    expect(annotated.inkColor?.value).toBe('#9a9a9a');
  });

  it('leaves a readable pair alone', () => {
    const annotated = annotateContrast({
      canvasColor: field('#ffffff'),
      inkColor: field('#111114'),
    });

    expect(annotated.canvasColor?.caveat).toBeUndefined();
    expect(annotated.inkColor?.caveat).toBeUndefined();
  });

  it('says nothing when only a canvas was proposed', () => {
    // With no ink the theme resolver derives one that reads by construction, so a warning here
    // would be about a pair that will never render — and would train admins to ignore the copy.
    const fields = { canvasColor: field('#8a8a8a') };
    expect(annotateContrast(fields)).toEqual(fields);
  });

  it('does not mutate the bag it was given', () => {
    const fields = { canvasColor: field('#8a8a8a'), inkColor: field('#9a9a9a') };
    const annotated = annotateContrast(fields);

    expect(fields.canvasColor.caveat).toBeUndefined();
    expect(annotated).not.toBe(fields);
  });
});
