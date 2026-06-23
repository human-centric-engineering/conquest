/**
 * Unit test: the markdown→HTML bridge (F14.5).
 *
 * Asserts `markdownToHtml` returns HTML for common markdown and an empty string for blank input.
 * (Sanitisation is intentionally NOT done here — it happens at the client render boundary.)
 */

import { describe, it, expect } from 'vitest';

import { markdownToHtml } from '@/lib/app/questionnaire/cohort-report/richtext';

describe('markdownToHtml', () => {
  it('converts headings, emphasis and lists to HTML', () => {
    const html = markdownToHtml('**bold** and *italic*\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<ul>');
  });

  it('returns an empty string for blank input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   ')).toBe('');
  });

  it('returns a string (never a Promise)', () => {
    expect(typeof markdownToHtml('hi')).toBe('string');
  });
});
