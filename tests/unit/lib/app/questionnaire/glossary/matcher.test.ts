/**
 * Glossary term matcher — unit tests (P16).
 *
 * The highest-value test file in this feature. The matcher decides what the respondent sees
 * underlined AND which definitions are worth prompt tokens, so a bug here is either a wrong
 * definition shown to a real person or an agent left uninformed about the word it is asking about.
 *
 * The cases below are the ones that actually break in practice: word-boundary bleed ("ego" inside
 * "egotistical"), alternation ordering (the two-word term losing to its own last word), the
 * hyphen/space equivalence that motivated the whole normalisation, and repeat-suppression.
 *
 * @see lib/app/questionnaire/glossary/matcher.ts
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_GLOSSARY_SURFACES,
  buildGlossaryIndex,
  findGlossaryMatches,
  matchingGlossaryEntries,
} from '@/lib/app/questionnaire/glossary/matcher';
import {
  GLOSSARY_MAX_ALIASES_PER_TERM,
  GLOSSARY_MAX_TERMS_PER_VERSION,
  type GlossaryEntry,
} from '@/lib/app/questionnaire/glossary/types';

function entry(
  termId: string,
  term: string,
  surfaces: string[] = [term],
  definitions: string[] = [`Definition of ${term}.`]
): GlossaryEntry {
  return { termId, term, surfaces, definitions };
}

const HIGHER_SELF = entry('t-higher', 'higher self', ['higher self', 'higher-self']);
const EGO = entry('t-ego', 'ego');
const SELF = entry('t-self', 'self');

/** Compile or fail loudly — every test below assumes a non-null index. */
function indexOf(entries: GlossaryEntry[]) {
  const index = buildGlossaryIndex(entries);
  if (!index) throw new Error('expected a non-null index');
  return index;
}

function matchedTerms(text: string, entries: GlossaryEntry[], oncePerTerm = true): string[] {
  return findGlossaryMatches(text, indexOf(entries), { oncePerTerm }).map((m) => m.entry.term);
}

describe('buildGlossaryIndex', () => {
  it('returns null for an empty entry set', () => {
    expect(buildGlossaryIndex([])).toBeNull();
  });

  it('returns null when no entry has a selected definition', () => {
    // A term with nothing ticked must never underline — the popover would be empty.
    expect(buildGlossaryIndex([entry('t-1', 'ego', ['ego'], [])])).toBeNull();
  });

  it('does NOT truncate a legitimately maximal glossary', () => {
    // THE REGRESSION. The cap was 200 while a 60-term glossary reaches ~300 surfaces with no
    // aliases at all. Because surfaces are ordered longest-first, the overflow dropped the
    // SHORTEST terms — exactly the short contested words this feature exists for. A version could
    // pass every validation and silently stop matching "ego", in the prompts as well as the hints.
    // Exactly what the save schema permits: 60 terms, each with the maximum 8 aliases. One of
    // them is the short, contested word the feature exists for.
    const maximal = [
      entry('t-ego', 'ego', [
        'ego',
        ...Array.from({ length: GLOSSARY_MAX_ALIASES_PER_TERM }, (_, a) => `egoalias${a}`),
      ]),
      ...Array.from({ length: GLOSSARY_MAX_TERMS_PER_VERSION - 1 }, (_, i) =>
        entry(`t-${i}`, `term${i}`, [
          `term${i}`,
          ...Array.from({ length: GLOSSARY_MAX_ALIASES_PER_TERM }, (_, a) => `t${i}a${a}`),
        ])
      ),
    ];

    const index = indexOf(maximal);
    expect(index.bySurface.size).toBeLessThanOrEqual(MAX_GLOSSARY_SURFACES);
    // The shortest term still matches — the whole point.
    expect(findGlossaryMatches('my ego today', index).map((m) => m.entry.term)).toEqual(['ego']);
  });

  it('still truncates beyond the backstop, keeping the longest surfaces', () => {
    // The cap remains a real backstop, just far above any glossary the save schema permits.
    // Built from many SHORT surfaces plus one long one: escalating-length surfaces would compile
    // a multi-megabyte alternation, which is the very thing the cap exists to prevent.
    const overflow = Array.from({ length: MAX_GLOSSARY_SURFACES + 50 }, (_, i) =>
      entry(`t-${i}`, `zz${i}`)
    );
    const long = entry('t-long', 'a distinctly longer glossary surface');
    const index = indexOf([...overflow, long]);

    expect(index.bySurface.size).toBeGreaterThan(MAX_GLOSSARY_SURFACES);
    // Longest-first ordering means the long surface survives the slice.
    expect(
      findGlossaryMatches('about a distinctly longer glossary surface here', index)
    ).toHaveLength(1);
  });
});

describe('findGlossaryMatches — what matches', () => {
  it('matches a term regardless of case', () => {
    expect(matchedTerms('My EGO gets in the way.', [EGO])).toEqual(['ego']);
    expect(matchedTerms('My Ego gets in the way.', [EGO])).toEqual(['ego']);
  });

  it('matches a hyphenated spelling of a spaced term, and vice versa', () => {
    // The motivating case: the questionnaire says "higher-self", the admin typed "higher self".
    expect(matchedTerms('Your higher-self knows.', [HIGHER_SELF])).toEqual(['higher self']);
    expect(matchedTerms('Your higher self knows.', [HIGHER_SELF])).toEqual(['higher self']);
  });

  it('matches across a line break inside a multi-word term', () => {
    expect(matchedTerms('Your higher\nself knows.', [HIGHER_SELF])).toEqual(['higher self']);
  });

  it('matches a curly apostrophe against a straight-apostrophe surface', () => {
    const possessive = entry('t-p', "respondent's self", ["respondent's self"]);
    expect(matchedTerms('The respondent’s self is at issue.', [possessive])).toEqual([
      "respondent's self",
    ]);
  });

  it('matches derived plurals and possessives without a stemmer', () => {
    expect(matchedTerms('Our egos collide.', [EGO])).toEqual(['ego']);
    expect(matchedTerms("The ego's demands.", [EGO])).toEqual(['ego']);
    expect(matchedTerms('The egos’ demands.', [EGO])).toEqual(['ego']);
  });

  it('matches an alias as well as the term itself', () => {
    const withAlias = entry('t-hs', 'higher self', ['higher self', 'HS']);
    expect(matchedTerms('Is HS a useful idea?', [withAlias])).toEqual(['higher self']);
  });

  it('returns spans that address the matched text exactly', () => {
    const text = 'Describe your ego honestly.';
    const [match] = findGlossaryMatches(text, indexOf([EGO]));
    expect(text.slice(match.start, match.end)).toBe('ego');
  });
});

describe('findGlossaryMatches — what must NOT match', () => {
  it('does not match inside a longer word', () => {
    // The single most damaging false positive: underlining "ego" inside "egotistical" and
    // showing a confidently wrong definition.
    expect(matchedTerms('He is egotistical.', [EGO])).toEqual([]);
    expect(matchedTerms('Talk about egoism.', [EGO])).toEqual([]);
    expect(matchedTerms('Their egocentric view.', [EGO])).toEqual([]);
  });

  it('DOES match across a hyphen, because hyphens are word separators here', () => {
    // A consequence of the hyphen folding that makes "higher-self" match "higher self": a hyphen
    // separates words, so "alter-ego" contains the standalone word "ego" exactly as "alter ego"
    // does. The alternative — hyphens as separators for matching but as word-characters for
    // boundaries — is incoherent, and would break the motivating "higher-self" case.
    expect(matchedTerms('Their alter-ego took over.', [EGO])).toEqual(['ego']);
    expect(matchedTerms('Their alter ego took over.', [EGO])).toEqual(['ego']);
  });

  it('does not match a multi-word term inside a longer word', () => {
    expect(matchedTerms('Their higher selfhood.', [HIGHER_SELF])).toEqual([]);
  });

  it('matches a term at the very start and very end of the text', () => {
    expect(matchedTerms('Ego matters.', [EGO])).toEqual(['ego']);
    expect(matchedTerms('Let us discuss ego', [EGO])).toEqual(['ego']);
  });

  it('matches a term adjacent to punctuation', () => {
    expect(matchedTerms('Your "ego", specifically.', [EGO])).toEqual(['ego']);
    expect(matchedTerms('(ego)', [EGO])).toEqual(['ego']);
  });

  it('treats regex metacharacters in a surface as literal text', () => {
    // An injected `.` or `+` would otherwise match arbitrary characters — or throw on compile.
    const weird = entry('t-cpp', 'C++', ['C++']);
    expect(matchedTerms('I write C++ daily.', [weird])).toEqual(['C++']);
    expect(matchedTerms('I write Cxx daily.', [weird])).toEqual([]);

    const dotted = entry('t-dot', 'a.b', ['a.b']);
    expect(matchedTerms('the a.b measure', [dotted])).toEqual(['a.b']);
    expect(matchedTerms('the axb measure', [dotted])).toEqual([]);
  });
});

describe('findGlossaryMatches — a rejected match must not swallow a shorter one', () => {
  it('still finds the shorter surface inside a rejected longer match', () => {
    // The regex advances `lastIndex` past the whole match before the boundary check runs. Without
    // resuming from start+1 on rejection, "self esteemed" consumed "self esteem" (rejected —
    // followed by `e`) and skipped the legitimate "self" at 0–4 entirely.
    const selfEsteem = entry('t-se', 'self esteem');
    const self = entry('t-self', 'self');
    expect(matchedTerms('self esteemed today', [selfEsteem, self])).toEqual(['self']);
  });

  it('leaves a genuinely non-matching text alone', () => {
    const selfEsteem = entry('t-se', 'self esteem');
    expect(matchedTerms('nothing relevant here', [selfEsteem])).toEqual([]);
  });

  it('does not loop or duplicate when the rejected match is at position 0', () => {
    const ego = entry('t-ego', 'ego');
    expect(matchedTerms('egotistical behaviour', [ego])).toEqual([]);
  });
});

describe('findGlossaryMatches — longest match wins', () => {
  it('prefers the two-word term over its own last word', () => {
    // Alternation is leftmost-first-alternative, so ordering by length is what makes this work.
    expect(matchedTerms('Ask about the higher self today.', [SELF, HIGHER_SELF])).toEqual([
      'higher self',
    ]);
  });

  it('is order-independent — declaring the short term first changes nothing', () => {
    expect(matchedTerms('Ask about the higher self today.', [HIGHER_SELF, SELF])).toEqual([
      'higher self',
    ]);
  });

  it('still matches the short term where it stands alone', () => {
    const found = matchedTerms('The self, and the higher self.', [SELF, HIGHER_SELF], false);
    expect(found).toEqual(['self', 'higher self']);
  });

  it('produces non-overlapping spans', () => {
    const text = 'The higher self and the self.';
    const matches = findGlossaryMatches(text, indexOf([SELF, HIGHER_SELF]), {
      oncePerTerm: false,
    });
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end);
    }
  });
});

describe('findGlossaryMatches — repetition and caps', () => {
  it('annotates only the first occurrence of a term by default', () => {
    // Four underlines of the same word reads as emphasis, not as a definition affordance.
    const text = 'ego, ego, ego and ego';
    expect(findGlossaryMatches(text, indexOf([EGO]))).toHaveLength(1);
  });

  it('annotates every occurrence when oncePerTerm is off', () => {
    const text = 'ego, ego, ego and ego';
    expect(findGlossaryMatches(text, indexOf([EGO]), { oncePerTerm: false })).toHaveLength(4);
  });

  it('carries a shared seen set across calls, so "first" spans a whole message', () => {
    const index = indexOf([EGO]);
    const seen = new Set<string>();
    expect(findGlossaryMatches('First paragraph: ego.', index, { seen })).toHaveLength(1);
    // Second paragraph of the SAME message — already annotated.
    expect(findGlossaryMatches('Second paragraph: ego.', index, { seen })).toHaveLength(0);
  });

  it('respects the match limit', () => {
    const text = Array.from({ length: 30 }, () => 'ego').join(' ');
    expect(
      findGlossaryMatches(text, indexOf([EGO]), { oncePerTerm: false, limit: 5 })
    ).toHaveLength(5);
  });

  it('returns nothing for text with no defined terms', () => {
    expect(matchedTerms('Nothing contested here at all.', [EGO, HIGHER_SELF])).toEqual([]);
  });
});

describe('matchingGlossaryEntries — the prompt relevance filter', () => {
  it('keeps only entries that appear somewhere in the haystack', () => {
    const found = matchingGlossaryEntries(
      [HIGHER_SELF, EGO],
      ['How connected do you feel to your higher self?', 'Some recent chatter.']
    );
    expect(found.map((e) => e.term)).toEqual(['higher self']);
  });

  it('scans every haystack entry, not just the first', () => {
    const found = matchingGlossaryEntries(
      [HIGHER_SELF, EGO],
      ['An unrelated question.', 'The respondent mentioned their ego.']
    );
    expect(found.map((e) => e.term)).toEqual(['ego']);
  });

  it('preserves the caller ordering (the admin ordinal), not discovery order', () => {
    const found = matchingGlossaryEntries(
      [HIGHER_SELF, EGO],
      ['ego first, then higher self in the text']
    );
    expect(found.map((e) => e.term)).toEqual(['higher self', 'ego']);
  });

  it('applies the same boundary rules as the hints — no bleed into longer words', () => {
    // The load-bearing property: the agent is told about exactly the terms the respondent sees.
    expect(matchingGlossaryEntries([EGO], ['Describe egotistical behaviour.'])).toEqual([]);
  });

  it('ignores empty and blank haystack entries', () => {
    expect(matchingGlossaryEntries([EGO], ['', '   '])).toEqual([]);
  });

  it('returns nothing for an empty entry set', () => {
    expect(matchingGlossaryEntries([], ['ego everywhere'])).toEqual([]);
  });
});
