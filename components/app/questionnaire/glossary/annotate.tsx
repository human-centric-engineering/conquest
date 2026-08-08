'use client';

/**
 * Splice {@link GlossaryTermMark}s into rendered text (P16).
 *
 * The shared kernel behind both the markdown annotator and the plain-text one.
 *
 * **Only STRING children are inspected.** That single rule is what structurally excludes code
 * spans and links from annotation: react-markdown hands those to a `components` override as React
 * *elements*, never as strings, so they pass through untouched without any regex having to
 * recognise them. It is a stronger guarantee than pattern-matching the markdown source, and it
 * cannot drift as the renderer changes.
 */

import { Children, Fragment, isValidElement, type ReactNode } from 'react';

import { findGlossaryMatches, type GlossaryIndex } from '@/lib/app/questionnaire/glossary/matcher';
import { GlossaryTermMark } from '@/components/app/questionnaire/glossary/glossary-term-mark';

/**
 * Annotate one string, returning it unchanged when nothing matches (so the common case allocates
 * no wrapper). `seen` is shared across a whole message so a term underlines once, not once per
 * paragraph.
 */
export function annotateString(text: string, index: GlossaryIndex, seen: Set<string>): ReactNode {
  const matches = findGlossaryMatches(text, index, { seen });
  if (matches.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, i) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(
      <GlossaryTermMark
        key={`${match.entry.termId}-${match.start}-${i}`}
        surface={text.slice(match.start, match.end)}
        entry={match.entry}
      />
    );
    cursor = match.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return parts.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}

/**
 * Annotate every string among `children`, passing non-string children through untouched.
 *
 * Recurses into nested React elements' children so a term inside `**bold**` or a list item is
 * still annotated — the interviewer bolds a phrase per message, and a defined term landing inside
 * it must not silently lose its definition. Code and links are excluded by their overrides being
 * absent, so this never sees their contents as strings.
 */
export function annotateChildren(
  children: ReactNode,
  index: GlossaryIndex,
  seen: Set<string>
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return annotateString(child, index, seen);
    if (typeof child === 'number' || child === null || child === undefined) return child;
    if (isValidElement<{ children?: ReactNode }>(child)) {
      const nested = child.props.children;
      if (nested === undefined) return child;
      // Never descend into a code span or a link: their text is deliberate verbatim content, and
      // an underline inside a URL or an identifier is noise at best and misleading at worst.
      if (child.type === 'code' || child.type === 'pre' || child.type === 'a') return child;
      return {
        ...child,
        props: { ...child.props, children: annotateChildren(nested, index, seen) },
      };
    }
    return child;
  });
}
