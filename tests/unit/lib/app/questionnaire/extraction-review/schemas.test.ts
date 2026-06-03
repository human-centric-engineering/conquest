import { describe, it, expect } from 'vitest';

import {
  listChangesQuerySchema,
  EXTRACTION_CHANGE_STATUSES,
} from '@/lib/app/questionnaire/extraction-review';

/**
 * Pin the F2.3 list-filter contract. The route hands `validateQueryParams` a plain
 * string map, so the schema must accept absent filters (no filter) and reject
 * off-vocabulary enum values.
 */
describe('listChangesQuerySchema', () => {
  it('accepts an empty query (no filters)', () => {
    expect(listChangesQuerySchema.parse({})).toEqual({});
  });

  it('accepts each valid filter', () => {
    const parsed = listChangesQuerySchema.parse({
      status: 'reverted',
      changeType: 'prune_question',
      targetEntityType: 'version',
    });
    expect(parsed).toEqual({
      status: 'reverted',
      changeType: 'prune_question',
      targetEntityType: 'version',
    });
  });

  it('rejects an unknown status', () => {
    expect(listChangesQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('rejects an unknown change type', () => {
    expect(listChangesQuerySchema.safeParse({ changeType: 'rename_section' }).success).toBe(false);
  });

  it('rejects an unknown target entity type', () => {
    expect(listChangesQuerySchema.safeParse({ targetEntityType: 'questionnaire' }).success).toBe(
      false
    );
  });

  it('exposes exactly the persisted status vocabulary', () => {
    expect([...EXTRACTION_CHANGE_STATUSES]).toEqual(['applied', 'reverted']);
  });
});
