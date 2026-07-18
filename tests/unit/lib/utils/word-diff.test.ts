/**
 * Unit test: word-level LCS diff.
 *
 * Pins the segment tagging (eq/del/ins), whitespace preservation (text reconstructs exactly), and the
 * large-input fallback to a whole-block replace.
 */

import { describe, it, expect } from 'vitest';

import { diffWords, MAX_TOKENS, type DiffSegment } from '@/lib/utils/word-diff';

/** Reconstruct the left (old) text from eq+del, and the right (new) text from eq+ins. */
function sides(segs: DiffSegment[]) {
  const left = segs
    .filter((s) => s.type !== 'ins')
    .map((s) => s.text)
    .join('');
  const right = segs
    .filter((s) => s.type !== 'del')
    .map((s) => s.text)
    .join('');
  return { left, right };
}

describe('diffWords', () => {
  it('marks unchanged text as eq and reconstructs both sides exactly', () => {
    const a = 'the quick brown fox';
    const b = 'the quick red fox';
    const segs = diffWords(a, b);
    const { left, right } = sides(segs);
    expect(left).toBe(a);
    expect(right).toBe(b);
    // "brown" removed, "red" added; "the quick " and " fox" unchanged.
    expect(segs.some((s) => s.type === 'del' && s.text.includes('brown'))).toBe(true);
    expect(segs.some((s) => s.type === 'ins' && s.text.includes('red'))).toBe(true);
    expect(segs.some((s) => s.type === 'eq' && s.text.includes('quick'))).toBe(true);
  });

  it('is all-eq for identical text', () => {
    const segs = diffWords('same text here', 'same text here');
    expect(segs.every((s) => s.type === 'eq')).toBe(true);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(diffWords('', 'hello world').every((s) => s.type === 'ins')).toBe(true);
    expect(diffWords('hello world', '').every((s) => s.type === 'del')).toBe(true);
  });

  it('falls back to a whole-block replace beyond the token cap', () => {
    const big = 'word '.repeat(MAX_TOKENS + 50);
    const segs = diffWords(big, 'different');
    expect(segs).toEqual([
      { text: big, type: 'del' },
      { text: 'different', type: 'ins' },
    ]);
  });
});
