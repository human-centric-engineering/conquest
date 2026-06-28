/**
 * Unit tests for `readCommentAggregation` — the free-text comment-field classifier reader.
 * It defaults to the narrow `isolated` behaviour and only returns `section` on an explicit flag.
 */

import { describe, it, expect } from 'vitest';

import {
  readCommentAggregation,
  FREE_TEXT_COMMENT_AGGREGATIONS,
} from '@/lib/app/questionnaire/types';

describe('readCommentAggregation', () => {
  it('returns section only when typeConfig says so', () => {
    expect(readCommentAggregation({ commentAggregation: 'section' })).toBe('section');
  });

  it('defaults to isolated for absent / malformed / unknown values', () => {
    expect(readCommentAggregation({ commentAggregation: 'isolated' })).toBe('isolated');
    expect(readCommentAggregation({ commentAggregation: 'whatever' })).toBe('isolated');
    expect(readCommentAggregation({})).toBe('isolated');
    expect(readCommentAggregation(null)).toBe('isolated');
    expect(readCommentAggregation(undefined)).toBe('isolated');
    expect(readCommentAggregation('section')).toBe('isolated'); // a string, not a record
    expect(readCommentAggregation(['section'])).toBe('isolated'); // an array
  });

  it('exposes exactly the two aggregation modes', () => {
    expect(FREE_TEXT_COMMENT_AGGREGATIONS).toEqual(['isolated', 'section']);
  });
});
