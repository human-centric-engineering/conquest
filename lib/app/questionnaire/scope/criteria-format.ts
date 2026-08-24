/**
 * Adaptive Scope (P17) — reading an author's routing criteria as the structure it already has.
 *
 * A conditional topic's `criteria` is free text: whatever the admin typed, or whatever the Routing
 * Analyst proposed. In practice both converge on the same shape, because it is the shape the
 * decision has — a lead-in sentence, then one line per signal, each usually naming the signal and
 * how much it counts for:
 *
 * ```
 * Include this when the opening shows ANY of the following — the more that apply, the stronger:
 * • Recent change (high priority) — they said something like: reorganised, just moved.
 * • Working with others (medium priority) — they said: partners, suppliers, other teams.
 * ```
 *
 * Rendered as one block of text that structure is invisible, and a reader has to re-derive the list
 * by eye every time they open the panel. This module recovers it so the panel can draw it.
 *
 * ## Recovery, never rewriting
 *
 * Nothing here edits the author's words. Every character of the input reaches the screen; the only
 * things moved are the bullet marker (which becomes the bullet the renderer draws) and the priority
 * marker (which becomes a chip beside the line it was already describing). Text that does not fit
 * the shape — a plain paragraph, a numbered list, a note typed after the bullets — falls through as
 * a `text` block and is rendered verbatim with its line breaks intact. A criteria string this module
 * cannot read is a criteria string it hands back whole, never one it silently drops half of.
 *
 * Pure: no React, no I/O. The parsing lives here rather than in the component so the "what did the
 * author actually say" question has one answer, and can be tested without a DOM.
 */

/** How much a signal counts for, when the author said so. */
export type CriteriaPriority = 'high' | 'medium' | 'low';

/** One signal in a criteria list. */
export interface CriteriaItem {
  /**
   * The short label the line leads with, when it has one — `"Recent change"` above.
   *
   * Null whenever the line does not obviously start with one, which is the safer answer: a term
   * wrongly split out of a sentence bolds a fragment and reads as a typo.
   */
  term: string | null;
  priority: CriteriaPriority | null;
  /** Everything else on the line, verbatim, with the markers this type carries removed. */
  body: string;
}

/** A run of the criteria text: prose, or a list of signals. */
export type CriteriaBlock =
  { kind: 'text'; text: string } | { kind: 'list'; items: CriteriaItem[] };

/**
 * Bullet markers an author might type, including the ones a word processor substitutes on paste.
 * Numbered lists are deliberately excluded — a bullet is a set, and a number is a sequence.
 */
const BULLET = /^\s*[•·*‣▪●\-–—]\s+/;

/** `(high priority)`, `(medium-priority)`, `(low priority)` — anywhere on the line. */
const PRIORITY = /\s*\((high|medium|low)[\s-]*priority\)\s*/i;

/** The dashes an author uses to separate a term from its explanation. Colons are NOT one of them. */
const TERM_SPLIT = /\s+[—–]\s+|\s+-\s+/;

/** Longest a leading fragment may be and still read as a label rather than a clause. */
const MAX_TERM_LENGTH = 48;

/** Most words a term may have. Beyond this it is a sentence that happens to contain a dash. */
const MAX_TERM_WORDS = 7;

/**
 * Split a criteria string into the blocks a renderer can lay out.
 *
 * Never throws and never returns nothing for non-empty input: unparseable text comes back as a
 * single `text` block, which renders exactly as the old panel rendered everything.
 */
export function parseCriteria(raw: string): CriteriaBlock[] {
  const text = raw.replace(/\r\n?/g, '\n');
  if (text.trim().length === 0) return [];

  const blocks: CriteriaBlock[] = [];
  let paragraph: string[] = [];
  let items: CriteriaItem[] = [];

  const flushParagraph = () => {
    const joined = paragraph.join('\n').trim();
    if (joined.length > 0) blocks.push({ kind: 'text', text: joined });
    paragraph = [];
  };
  const flushList = () => {
    if (items.length > 0) blocks.push({ kind: 'list', items });
    items = [];
  };

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      // A blank line ends whatever was open. It is the one separator every author agrees on.
      flushParagraph();
      flushList();
      continue;
    }

    if (BULLET.test(line)) {
      flushParagraph();
      items.push(toItem(line.replace(BULLET, '')));
      continue;
    }

    // An indented line under a bullet is that bullet wrapping, not a new thought. Unindented text
    // after a list ends the list — an author who types a closing sentence has stopped listing.
    if (items.length > 0 && /^\s{2,}/.test(line)) {
      const last = items[items.length - 1];
      if (last) last.body = `${last.body} ${line.trim()}`.trim();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Read one bullet's text into its parts. */
function toItem(line: string): CriteriaItem {
  let body = line.trim();

  const found = PRIORITY.exec(body);
  const priority = found?.[1] ? (found[1].toLowerCase() as CriteriaPriority) : null;
  if (found) {
    // Replaced with a single space rather than removed, so `A (high priority) B` does not become `AB`.
    body = body
      .replace(PRIORITY, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // The marker often sat at the end of a clause, leaving the clause's own dash dangling.
    body = body
      .replace(/^[—–-]\s*/, '')
      .replace(/\s*[—–-]$/, '')
      .trim();
  }

  return { term: takeTerm(body), priority, body: takeTermRest(body) };
}

/** The leading label, if the line has one that reads like a label. */
function takeTerm(body: string): string | null {
  const parts = body.split(TERM_SPLIT);
  if (parts.length < 2) return null;
  const candidate = (parts[0] ?? '').trim();
  if (candidate.length === 0 || candidate.length > MAX_TERM_LENGTH) return null;
  // A full stop or a question mark means the "term" is a finished sentence, not a heading for one.
  if (/[.!?]/.test(candidate)) return null;
  if (candidate.split(/\s+/).length > MAX_TERM_WORDS) return null;
  // Nothing may be left over: a term with an empty body would print a heading and no line.
  return parts.slice(1).join(' ').trim().length > 0 ? candidate : null;
}

/** The line with its leading label removed — or the whole line, when there was none. */
function takeTermRest(body: string): string {
  if (takeTerm(body) === null) return body;
  const at = body.search(TERM_SPLIT);
  const match = TERM_SPLIT.exec(body);
  return at >= 0 && match ? body.slice(at + match[0].length).trim() : body;
}
