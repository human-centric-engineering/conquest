/**
 * Glossary prompt injection — unit tests (P16).
 *
 * The property most likely to regress silently is "zero cost when absent": if an empty glossary
 * ever produced a non-empty section, every turn of every questionnaire would pay tokens for an
 * empty instruction block. It is asserted from several angles below.
 *
 * The other load-bearing behaviour is multi-sense serialisation: when an admin deliberately keeps
 * two readings of a term, the prompt must present both as alternatives rather than merging them.
 *
 * @see lib/app/questionnaire/glossary/injection.ts
 */

import { describe, it, expect } from 'vitest';

import {
  GLOSSARY_MAX_DEFINITION_CHARS,
  GLOSSARY_MAX_TERMS,
  GLOSSARY_PROMPT_PREAMBLE,
  allGlossaryLines,
  formatGlossarySection,
  selectGlossaryLines,
} from '@/lib/app/questionnaire/glossary/injection';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

function entry(termId: string, term: string, definitions: string[]): GlossaryEntry {
  return { termId, term, surfaces: [term], definitions };
}

const HIGHER_SELF = entry('t-hs', 'higher self', ['The observing, values-led part of you.']);
const EGO = entry('t-ego', 'ego', [
  'The constructed self that seeks approval and control.',
  'In the Jungian sense, the conscious centre of the personality.',
]);

describe('selectGlossaryLines — relevance', () => {
  it('keeps only the terms this turn is actually about', () => {
    const lines = selectGlossaryLines(
      [HIGHER_SELF, EGO],
      ['How connected do you feel to your higher self?']
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('higher self');
    expect(lines[0]).not.toContain('Jungian');
  });

  it('picks up a term mentioned only in the recent transcript', () => {
    const lines = selectGlossaryLines(
      [EGO],
      ['An unrelated question.', 'Respondent: my ego gets in the way.']
    );
    expect(lines).toHaveLength(1);
  });

  it('returns [] when no term is relevant, so the section collapses', () => {
    expect(selectGlossaryLines([HIGHER_SELF, EGO], ['Something entirely unrelated.'])).toEqual([]);
  });

  it('returns [] for an empty glossary without scanning anything', () => {
    expect(selectGlossaryLines([], ['higher self and ego everywhere'])).toEqual([]);
  });

  it('does not fire on a term embedded in a longer word', () => {
    // Same boundary rules as the respondent hints — the agent is briefed on exactly the terms the
    // respondent can see underlined, never a superset.
    expect(selectGlossaryLines([EGO], ['Describe egotistical behaviour.'])).toEqual([]);
  });

  it('caps the number of injected terms', () => {
    const many = Array.from({ length: GLOSSARY_MAX_TERMS + 4 }, (_, i) =>
      entry(`t-${i}`, `term${i}`, [`Definition ${i}.`])
    );
    const haystack = many.map((e) => `mentions ${e.term} here`);
    expect(selectGlossaryLines(many, haystack)).toHaveLength(GLOSSARY_MAX_TERMS);
  });

  it('preserves the admin ordering when capping', () => {
    const many = Array.from({ length: GLOSSARY_MAX_TERMS + 2 }, (_, i) =>
      entry(`t-${i}`, `term${i}`, [`Definition ${i}.`])
    );
    const lines = selectGlossaryLines(
      many,
      many.map((e) => `mentions ${e.term}`)
    );
    expect(lines[0]).toContain('term0');
    expect(lines.at(-1)).toContain(`term${GLOSSARY_MAX_TERMS - 1}`);
  });
});

describe('selectGlossaryLines — formatting', () => {
  it('renders a single definition as plain prose', () => {
    const [line] = selectGlossaryLines([HIGHER_SELF], ['about your higher self']);
    expect(line).toBe('- higher self: The observing, values-led part of you.');
  });

  it('numbers multiple senses rather than merging them', () => {
    // The whole point of a multi-select: the ambiguity is real and both readings are accepted.
    const [line] = selectGlossaryLines([EGO], ['about your ego']);
    expect(line).toContain('(1) The constructed self');
    expect(line).toContain('(2) In the Jungian sense');
    expect(line).toMatch(/^- ego: \(1\) .+; \(2\) .+$/);
  });

  it('truncates a long definition on a word boundary', () => {
    const long = entry('t-l', 'term', [`${'word '.repeat(200)}end`]);
    const [line] = selectGlossaryLines([long], ['the term here']);
    const definition = line.replace('- term: ', '');
    expect(definition.length).toBeLessThanOrEqual(GLOSSARY_MAX_DEFINITION_CHARS + 1);
    expect(definition.endsWith('…')).toBe(true);
    expect(definition).not.toContain('wor…');
  });

  it('drops a term whose definitions are all blank', () => {
    const blank = entry('t-b', 'ego', ['   ']);
    expect(selectGlossaryLines([blank], ['about ego'])).toEqual([]);
  });
});

describe('allGlossaryLines — the unfiltered surface', () => {
  it('returns every term without needing a haystack', () => {
    // Report generation runs once per session, not per turn, so filtering would only risk
    // dropping a term the writer needs.
    expect(allGlossaryLines([HIGHER_SELF, EGO])).toHaveLength(2);
  });

  it('is UNCAPPED — the report writer must see the same terms the appendix prints', () => {
    // The per-turn cap protects the ~220-token phraser prompt. Applying it here gave the report
    // writer 8 terms while `buildGlossaryAppendix` printed all of them, so a reader saw
    // definitions the prose had been written without.
    const many = Array.from({ length: GLOSSARY_MAX_TERMS + 12 }, (_, i) =>
      entry(`t-${i}`, `term${i}`, [`Definition ${i}.`])
    );
    expect(allGlossaryLines(many)).toHaveLength(GLOSSARY_MAX_TERMS + 12);
  });

  it('still numbers multiple senses', () => {
    expect(allGlossaryLines([EGO])[0]).toContain('(2)');
  });

  it('returns [] for an empty set', () => {
    expect(allGlossaryLines([])).toEqual([]);
  });
});

describe('formatGlossarySection', () => {
  it('returns an empty string for no lines — the zero-cost-when-absent contract', () => {
    // If this ever returned a non-empty string, every turn of every questionnaire would pay for
    // an empty instruction block.
    expect(formatGlossarySection([])).toBe('');
  });

  it('leads with the preamble, then the lines', () => {
    const section = formatGlossarySection(['- ego: A definition.']);
    expect(section.startsWith(GLOSSARY_PROMPT_PREAMBLE)).toBe(true);
    expect(section).toContain('- ego: A definition.');
  });

  it('instructs the agent not to recite, not to merge senses, and to ask when it matters', () => {
    // Each clause exists because of a specific way this goes wrong without it.
    expect(GLOSSARY_PROMPT_PREAMBLE).toContain('Do NOT read these');
    expect(GLOSSARY_PROMPT_PREAMBLE).toContain('do not collapse them');
    expect(GLOSSARY_PROMPT_PREAMBLE).toContain('ask');
  });
});
