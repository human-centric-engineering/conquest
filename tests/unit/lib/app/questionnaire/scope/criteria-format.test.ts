/**
 * Unit tests: reading an author's routing criteria as structure.
 *
 * The governing property is not "does it find the bullets" but **nothing is lost**. The panel renders
 * whatever comes back and nothing else, so a parser that quietly dropped a clause would delete an
 * author's routing instruction from the only surface that shows it. Most of what follows is that
 * property under the shapes real criteria arrive in.
 */

import { describe, expect, it } from 'vitest';

import { parseCriteria, type CriteriaBlock } from '@/lib/app/questionnaire/scope/criteria-format';

/** Everything the blocks would render, concatenated — for the nothing-is-lost assertions. */
function rendered(blocks: CriteriaBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === 'text'
        ? block.text
        : block.items.map((i) => `${i.term ?? ''} ${i.body}`).join(' ')
    )
    .join(' ');
}

const REAL = [
  'Include this when the opening shows ANY of the following — the more that apply, the stronger the case:',
  '• Growth source — new business (high priority) — they said something like: new logo, new customers, acquisition, hunting, market share, land. Highest-value routing signal.',
  '• Partner and channel (medium priority) — they said something like: partners, resellers, channel, alliances, ecosystem, distributors, conflict.',
].join('\n');

describe('parseCriteria', () => {
  it('returns nothing for empty or blank criteria', () => {
    expect(parseCriteria('')).toEqual([]);
    expect(parseCriteria('   \n  \n')).toEqual([]);
  });

  it('splits a real criteria string into its lead-in and its signals', () => {
    const blocks = parseCriteria(REAL);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'text',
      text: 'Include this when the opening shows ANY of the following — the more that apply, the stronger the case:',
    });
    expect(blocks[1]?.kind).toBe('list');
  });

  it('lifts the term and the priority off each signal, leaving the rest verbatim', () => {
    const blocks = parseCriteria(REAL);
    const list = blocks[1];
    if (list?.kind !== 'list') throw new Error('expected a list block');

    expect(list.items[0]).toEqual({
      term: 'Growth source',
      priority: 'high',
      body: 'new business — they said something like: new logo, new customers, acquisition, hunting, market share, land. Highest-value routing signal.',
    });
    expect(list.items[1]).toEqual({
      term: 'Partner and channel',
      priority: 'medium',
      body: 'they said something like: partners, resellers, channel, alliances, ecosystem, distributors, conflict.',
    });
  });

  it('keeps every word of the author’s text somewhere on screen', () => {
    const out = rendered(parseCriteria(REAL));
    for (const word of ['distributors', 'acquisition', 'Highest-value', 'stronger']) {
      expect(out).toContain(word);
    }
  });

  it('reads the bullet characters an author or a word processor actually produces', () => {
    for (const marker of ['•', '-', '*', '–', '·', '▪']) {
      const blocks = parseCriteria(`${marker} Revenue mix — they mentioned pricing`);
      expect(blocks[0]?.kind, marker).toBe('list');
    }
  });

  it('treats a numbered line as prose, because a numbered list is a sequence and this is a set', () => {
    const blocks = parseCriteria('1. First thing\n2. Second thing');
    expect(blocks).toEqual([{ kind: 'text', text: '1. First thing\n2. Second thing' }]);
  });

  it('falls back to one verbatim block when there is no list at all', () => {
    const prose = 'Ask this whenever the respondent sounds unsure about their pipeline.';
    expect(parseCriteria(prose)).toEqual([{ kind: 'text', text: prose }]);
  });

  it('preserves the line breaks inside a prose block', () => {
    const blocks = parseCriteria('First line\nSecond line');
    expect(blocks).toEqual([{ kind: 'text', text: 'First line\nSecond line' }]);
  });

  it('normalises Windows line endings rather than trailing carriage returns into the output', () => {
    const blocks = parseCriteria('Lead in:\r\n• One thing — matters\r\n');
    expect(blocks[0]).toEqual({ kind: 'text', text: 'Lead in:' });
    const list = blocks[1];
    if (list?.kind !== 'list') throw new Error('expected a list block');
    expect(list.items[0]?.body).toBe('matters');
  });

  it('joins an indented continuation onto the bullet it belongs to', () => {
    const blocks = parseCriteria('• Growth source — new business\n    and anything adjacent to it');
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list block');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.body).toBe('new business and anything adjacent to it');
  });

  it('ends the list when unindented prose follows it, rather than swallowing the closing note', () => {
    const blocks = parseCriteria('• One signal — matters\nSkip this topic for tiny teams.');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'text']);
    expect(blocks[1]).toEqual({ kind: 'text', text: 'Skip this topic for tiny teams.' });
  });

  it('takes the priority marker wherever it sits, and in whatever case', () => {
    const blocks = parseCriteria('• (LOW priority) they mentioned offboarding');
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list block');
    expect(list.items[0]).toEqual({
      term: null,
      priority: 'low',
      body: 'they mentioned offboarding',
    });
  });

  it('does not leave a dangling dash where the priority marker was removed', () => {
    const blocks = parseCriteria('• Growth source (high priority) —');
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list block');
    expect(list.items[0]?.body).toBe('Growth source');
    expect(list.items[0]?.term).toBeNull();
  });

  describe('when a leading fragment is not a term', () => {
    it('refuses a fragment that is a finished sentence', () => {
      const blocks = parseCriteria(
        '• They said the pricing is wrong. — and they wanted to talk about it'
      );
      const list = blocks[0];
      if (list?.kind !== 'list') throw new Error('expected a list block');
      expect(list.items[0]?.term).toBeNull();
      expect(list.items[0]?.body).toContain('They said the pricing is wrong.');
    });

    it('refuses a fragment that is too long to read as a label', () => {
      const long = 'a'.repeat(60);
      const blocks = parseCriteria(`• ${long} — the rest`);
      const list = blocks[0];
      if (list?.kind !== 'list') throw new Error('expected a list block');
      expect(list.items[0]?.term).toBeNull();
      expect(list.items[0]?.body).toBe(`${long} — the rest`);
    });

    it('refuses a fragment of too many words', () => {
      const blocks = parseCriteria('• one two three four five six seven eight — the rest');
      const list = blocks[0];
      if (list?.kind !== 'list') throw new Error('expected a list block');
      expect(list.items[0]?.term).toBeNull();
    });

    it('does not split on a colon — “they said something like:” is not a term', () => {
      const blocks = parseCriteria('• they said something like: partners, resellers');
      const list = blocks[0];
      if (list?.kind !== 'list') throw new Error('expected a list block');
      expect(list.items[0]?.term).toBeNull();
      expect(list.items[0]?.body).toBe('they said something like: partners, resellers');
    });

    it('keeps the whole line when a dash leaves nothing after it', () => {
      const blocks = parseCriteria('• Growth source —');
      const list = blocks[0];
      if (list?.kind !== 'list') throw new Error('expected a list block');
      expect(list.items[0]?.term).toBeNull();
      expect(list.items[0]?.body).toBe('Growth source —');
    });
  });
});
