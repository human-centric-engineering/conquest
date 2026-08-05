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

  // The constructs below are the ones marked's own breaking-change notes touch: v17 reworked list
  // and checkbox tokens, v18 trims trailing blank lines from block tokens and changed how GFM
  // tables capture trailing newlines. Section bodies are stored as HTML, so a silent shift here
  // rewrites what the Tiptap editor and the PDF render for reports already in the database —
  // pinning the output is what makes the next `marked` bump a visible diff rather than a surprise.
  describe('output shape across marked upgrades', () => {
    it('renders a GFM table without swallowing the paragraph that follows', () => {
      const html = markdownToHtml(
        '| Theme | Count |\n| --- | --- |\n| Workload | 12 |\n\n\nTrailing paragraph.\n'
      );
      expect(html).toContain('<th>Theme</th>');
      expect(html).toContain('<td>Workload</td>');
      expect(html).toContain('</table>');
      expect(html).toContain('<p>Trailing paragraph.</p>');
    });

    it('keeps loose list items wrapped in paragraphs and tight ones bare', () => {
      expect(markdownToHtml('- one\n\n- two\n')).toBe(
        '<ul>\n<li><p>one</p>\n</li>\n<li><p>two</p>\n</li>\n</ul>\n'
      );
      expect(markdownToHtml('- one\n- two\n')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n');
    });

    it('nests sub-lists inside their parent item', () => {
      expect(markdownToHtml('- parent\n  - child\n')).toBe(
        '<ul>\n<li>parent<ul>\n<li>child</li>\n</ul>\n</li>\n</ul>\n'
      );
    });

    it('renders task-list checkboxes as disabled inputs', () => {
      const html = markdownToHtml('- [ ] not done\n- [x] done\n');
      expect(html).toContain('<input disabled="" type="checkbox"> not done');
      expect(html).toContain('<input checked="" disabled="" type="checkbox"> done');
    });

    it('collapses runs of blank lines between blocks', () => {
      expect(markdownToHtml('# Title\n\n\n\nBody after several blank lines.\n\n\n')).toBe(
        '<h1>Title</h1>\n<p>Body after several blank lines.</p>\n'
      );
    });

    // Not a recommendation to trust model output — it documents that this function is deliberately
    // not the sanitisation boundary (dompurify at render is). If a future marked starts escaping
    // here, that is a behaviour change worth noticing, not a silent security upgrade to rely on.
    it('passes raw HTML through unescaped (sanitisation happens at render)', () => {
      const html = markdownToHtml('Text with <span class="x">inline html</span>\n');
      expect(html).toContain('<span class="x">inline html</span>');
    });
  });
});
