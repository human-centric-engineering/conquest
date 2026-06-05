import { describe, expect, it } from 'vitest';

import {
  completionOfferJsonSchema,
  validateCompletionOffer,
} from '@/lib/app/questionnaire/completion';

describe('validateCompletionOffer', () => {
  it('accepts a well-formed offer and returns the typed value', () => {
    const result = validateCompletionOffer({
      offerMessage: 'It looks like we have what we need — shall I submit?',
      coveredSummary: 'We covered your goals and timeline.',
      remainingNote: 'You can still add notes if you like.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.offerMessage).toContain('submit');
      expect(result.value.remainingNote).toBeDefined();
    }
  });

  it('accepts an offer without the optional remainingNote', () => {
    const result = validateCompletionOffer({
      offerMessage: 'Ready to submit?',
      coveredSummary: 'Everything is covered.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.remainingNote).toBeUndefined();
  });

  it('reports the named issue paths for a missing required field', () => {
    const result = validateCompletionOffer({ coveredSummary: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('offerMessage');
    }
  });

  it('rejects an empty offerMessage', () => {
    const result = validateCompletionOffer({ offerMessage: '', coveredSummary: 'x' });
    expect(result.ok).toBe(false);
  });

  it('serialises a JSON schema with the offer properties', () => {
    const props = (completionOfferJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toBeDefined();
    expect(props).toHaveProperty('offerMessage');
    expect(props).toHaveProperty('coveredSummary');
    expect(props).toHaveProperty('remainingNote');
  });
});
