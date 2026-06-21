/**
 * Unit: round briefing selection + formatting (`selectBriefingLines`).
 */

import { describe, it, expect } from 'vitest';

import {
  selectBriefingLines,
  BRIEFING_MAX_ENTRIES,
  BRIEFING_MAX_CONTENT_CHARS,
  type BriefingEntryLite,
} from '@/lib/app/questionnaire/rounds/briefing';

const general = (title: string, content = 'c'): BriefingEntryLite => ({
  questionSlotId: null,
  title,
  content,
});
const attributed = (slotId: string, title: string, content = 'c'): BriefingEntryLite => ({
  questionSlotId: slotId,
  title,
  content,
});

describe('selectBriefingLines', () => {
  it('always includes general (null-slot) entries', () => {
    const lines = selectBriefingLines([general('Revenue', '£4m ARR')], new Set());
    expect(lines).toEqual(['Revenue: £4m ARR']);
  });

  it('includes an entry attributed to a relevant question, and excludes others', () => {
    const entries = [
      attributed('q1', 'For Q1', 'fact one'),
      attributed('q2', 'For Q2', 'fact two'),
    ];
    const lines = selectBriefingLines(entries, new Set(['q1']));
    expect(lines).toEqual(['For Q1: fact one']);
  });

  it('combines general + attributed for the asked question, preserving input order', () => {
    const entries = [
      general('Background'),
      attributed('q1', 'Q1 note'),
      attributed('q9', 'Q9 note'),
    ];
    const lines = selectBriefingLines(entries, new Set(['q1']));
    expect(lines).toEqual(['Background: c', 'Q1 note: c']);
  });

  it('returns [] when nothing applies (no general, no relevant attributed)', () => {
    expect(selectBriefingLines([attributed('q5', 'x')], new Set(['q1']))).toEqual([]);
  });

  it('caps the number of injected entries', () => {
    const many = Array.from({ length: BRIEFING_MAX_ENTRIES + 5 }, (_, i) => general(`T${i}`));
    expect(selectBriefingLines(many, new Set())).toHaveLength(BRIEFING_MAX_ENTRIES);
  });

  it('truncates over-long content with an ellipsis', () => {
    const long = 'x'.repeat(BRIEFING_MAX_CONTENT_CHARS + 200);
    const [line] = selectBriefingLines([general('T', long)], new Set());
    expect(line.endsWith('…')).toBe(true);
    // Title + ': ' + truncated content (≤ cap) + ellipsis — comfortably under the raw length.
    expect(line.length).toBeLessThan(BRIEFING_MAX_CONTENT_CHARS + 50);
  });

  it('drops a blank title gracefully (content only, no leading ": ")', () => {
    const lines = selectBriefingLines(
      [{ questionSlotId: null, title: '  ', content: 'bare' }],
      new Set()
    );
    expect(lines).toEqual(['bare']);
  });
});
