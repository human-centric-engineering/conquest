/**
 * Glossary term matching (P16) — the one place that decides "does this text use a defined term?".
 *
 * TWO consumers share this module, and they must never disagree:
 *   1. the respondent-facing annotator, which underlines a matched term in the chat and on form
 *      labels;
 *   2. the server-side prompt relevance filter, which decides which definitions are worth the
 *      tokens on this turn.
 *
 * If those drifted apart you would get a term explained to the respondent but not to the agent
 * interpreting their answer — precisely the failure the glossary exists to prevent. Hence one
 * matcher, used by both.
 *
 * Pure: no Prisma, no React, no server imports. Safe in a client bundle.
 */

import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';
import {
  GLOSSARY_MAX_ALIASES_PER_TERM,
  GLOSSARY_MAX_TERMS_PER_VERSION,
  type GlossaryEntry,
} from '@/lib/app/questionnaire/glossary/types';

/** How many variants {@link inflectionsOf} emits — the surface cap is derived from this. */
const INFLECTIONS_PER_SURFACE = 5;

/**
 * Cap on surfaces in one index — a backstop against a pathological alternation, NOT a budget a
 * real glossary is expected to hit.
 *
 * Sized against the actual worst case the save schema permits: `GLOSSARY_MAX_TERMS_PER_VERSION`
 * (60) terms x (1 term + 8 aliases) x {@link INFLECTIONS_PER_SURFACE} (5) = 2700. The previous
 * value of 200 was BELOW a legitimate 60-term glossary (which reaches ~300 surfaces with no
 * aliases at all), and because surfaces are ordered longest-first the overflow silently dropped
 * the SHORTEST terms — exactly the short, contested words this feature exists for ("ego" is three
 * characters). A version could pass every validation and quietly stop matching its most important
 * term, in the prompts as well as the hints.
 */
export const MAX_GLOSSARY_SURFACES =
  GLOSSARY_MAX_TERMS_PER_VERSION * (1 + GLOSSARY_MAX_ALIASES_PER_TERM) * INFLECTIONS_PER_SURFACE;

/** Cap on matches returned from one text — a bound on how much any single message can annotate. */
export const MAX_GLOSSARY_MATCHES = 40;

/** A resolved hit: the span in the source text and the entry it belongs to. */
export interface GlossaryMatch {
  start: number;
  end: number;
  entry: GlossaryEntry;
}

/** A compiled index. Build once per entry set; reuse across texts. */
export interface GlossaryIndex {
  /** One combined alternation, longest-surface-first. Stateful (`g`) — reset before each scan. */
  pattern: RegExp;
  /** Normalised surface → the entry that owns it. */
  bySurface: Map<string, GlossaryEntry>;
  entries: readonly GlossaryEntry[];
}

/**
 * Characters that continue a word. Used for manual boundary checks instead of `\b`, which is wrong
 * here twice over: it does not fire between a space and a multi-word surface's edge, and it treats
 * an apostrophe as a boundary so "respondent's self" would half-match. Lookbehind would be the
 * other fix, but it is unavailable on Safari ≤16.3, which respondents do use.
 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Escape a surface for literal use inside the alternation — a term may contain `+`, `(`, `.`… */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cheap inflection variants of one normalised surface.
 *
 * Deliberately NOT a stemmer. A stemmer would collapse "egoism" onto "ego", which is a different
 * concept and would underline the wrong word with a confidently wrong definition. These four
 * cover the overwhelmingly common cases (`egos`, `ego's`, `boxes`, plural possessive); anything
 * irregular is the admin's job via `aliases`, which is honest and testable.
 */
function inflectionsOf(surface: string): string[] {
  if (surface.length === 0) return [];
  return [surface, `${surface}s`, `${surface}es`, `${surface}'s`, `${surface}s'`];
}

/**
 * Compile an index from the entries.
 *
 * Returns `null` for an empty set so every call site's guard is a single `if (!index)` — there is
 * no "empty index" object to reason about, and a version with no accepted terms costs nothing.
 *
 * Surfaces are sorted LONGEST FIRST before the alternation is built. JS alternation is
 * leftmost-*first-alternative*, so `higher self|self` matches the two-word term in "my higher
 * self" while `self|higher self` would match only "self" — the ordering is what makes
 * longest-match-first work, not an accident of input order.
 */
export function buildGlossaryIndex(entries: readonly GlossaryEntry[]): GlossaryIndex | null {
  const bySurface = new Map<string, GlossaryEntry>();

  for (const entry of entries) {
    if (entry.definitions.length === 0) continue;
    for (const surface of entry.surfaces) {
      for (const variant of inflectionsOf(normalizeGlossarySurface(surface))) {
        // First entry to claim a surface keeps it. A collision means two terms declared the same
        // word; the save schema already rejects that for terms, so this only guards aliases.
        if (variant.length > 0 && !bySurface.has(variant)) bySurface.set(variant, entry);
      }
    }
  }
  if (bySurface.size === 0) return null;

  const surfaces = [...bySurface.keys()]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_GLOSSARY_SURFACES);

  // The source text is matched as written, so the pattern must tolerate what normalisation folded:
  // any run of whitespace or hyphens where the normalised surface has a space, and any apostrophe
  // variant where it has a straight one.
  const alternation = surfaces
    .map((surface) =>
      escapeRegex(surface).replace(/ /g, '[\\s\\u2010-\\u2015-]+').replace(/'/g, "['‘’ʼ]")
    )
    .join('|');

  return {
    // The trailing lookahead is load-bearing, not decoration. Without it the engine commits to
    // the first (longest) alternative and a manual right-boundary check can only REJECT it — by
    // which point `lastIndex` has consumed the whole span, hiding any shorter surface inside it
    // ("self esteemed" ate "self esteem", then skipped the legitimate "self" at 0-4). Inside the
    // pattern, a failed boundary makes the engine BACKTRACK and try "self" at the same position.
    //
    // The LEFT boundary stays a manual check below: lookbehind is unavailable on Safari <=16.3,
    // and it needs no backtracking — every alternative starts at the same index, so if the left
    // boundary fails there, no shorter alternative would help.
    pattern: new RegExp(`(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu'),
    bySurface,
    entries,
  };
}

export interface FindGlossaryMatchesOptions {
  /**
   * Annotate only the FIRST occurrence of each term (default `true`).
   *
   * A turn that says "ego" four times with four dotted underlines reads as emphasis, not as a
   * definition affordance — the respondent stops seeing it as a control. Pass a shared `seen` set
   * across the paragraphs of one message so the "first" is per message, not per paragraph.
   */
  oncePerTerm?: boolean;
  /** Term ids already annotated, mutated in place. Supply one per message to span its paragraphs. */
  seen?: Set<string>;
  /** Cap on matches returned. Defaults to {@link MAX_GLOSSARY_MATCHES}. */
  limit?: number;
}

/**
 * Find every glossary term used in `text`, in source order, with non-overlapping spans.
 *
 * Overlap is structurally impossible rather than filtered: the regex is stateful and `lastIndex`
 * advances past each accepted match, so the next scan starts after it.
 */
export function findGlossaryMatches(
  text: string,
  index: GlossaryIndex,
  options: FindGlossaryMatchesOptions = {}
): GlossaryMatch[] {
  const { oncePerTerm = true, limit = MAX_GLOSSARY_MATCHES } = options;
  const seen = options.seen ?? new Set<string>();
  const matches: GlossaryMatch[] = [];

  index.pattern.lastIndex = 0;
  let match = index.pattern.exec(text);
  while (match !== null && matches.length < limit) {
    const start = match.index;
    const end = start + match[0].length;

    // Reject a hit that continues a preceding word: "ego" must not match inside "alterego".
    // The RIGHT boundary is already enforced by the pattern's lookahead (see above).
    const before = start === 0 || !WORD_CHAR.test(text[start - 1] ?? '');

    if (before) {
      const entry = index.bySurface.get(normalizeGlossarySurface(match[0]));
      if (entry && !(oncePerTerm && seen.has(entry.termId))) {
        if (oncePerTerm) seen.add(entry.termId);
        matches.push({ start, end, entry });
      }
    }

    // Zero-length match guard: no surface is empty, but the pattern is assembled from data, so a
    // defensive advance is cheaper than a hung render.
    if (index.pattern.lastIndex === start) index.pattern.lastIndex = start + 1;
    match = index.pattern.exec(text);
  }

  return matches;
}

/**
 * Which of `entries` appear anywhere in `haystack`. The relevance filter behind prompt injection.
 *
 * Uses the same index and the same boundary rules as the respondent hints, so "the agent was told
 * what this word means" and "the respondent can see what this word means" are always the same set
 * of terms for a given turn.
 */
export function matchingGlossaryEntries(
  entries: readonly GlossaryEntry[],
  haystack: readonly string[]
): GlossaryEntry[] {
  const index = buildGlossaryIndex(entries);
  if (!index) return [];

  const hit = new Set<string>();
  for (const text of haystack) {
    if (!text) continue;
    for (const match of findGlossaryMatches(text, index, { oncePerTerm: false })) {
      hit.add(match.entry.termId);
    }
  }
  // Preserve the caller's order (ordinal), not discovery order — the admin's ordering is the one
  // that reaches the prompt.
  return entries.filter((entry) => hit.has(entry.termId));
}
