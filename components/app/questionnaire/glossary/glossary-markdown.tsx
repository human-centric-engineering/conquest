'use client';

/**
 * Markdown renderer that underlines defined glossary terms (P16).
 *
 * A drop-in replacement for `<Markdown>{content}</Markdown>` in the respondent chat. When no
 * glossary applies it renders a plain `<Markdown>` with no overrides at all, so a questionnaire
 * without definitions is unaffected down to the React element level.
 *
 * No new dependency: this is a react-markdown `components` override that splits string children,
 * not a rehype plugin. `rehype-*` and `unist-util-visit` are not in the project, and the override
 * approach turns out to be *better* here — see `annotate.tsx` on why only inspecting strings is a
 * structural guarantee rather than a heuristic.
 */

import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';

import { annotateChildren } from '@/components/app/questionnaire/glossary/annotate';
import { buildGlossaryIndex, type GlossaryIndex } from '@/lib/app/questionnaire/glossary/matcher';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

export interface GlossaryMarkdownProps {
  children: string;
  /** The version's live glossary. Empty/absent → a plain `<Markdown>`, no overrides. */
  glossary?: readonly GlossaryEntry[];
}

export function GlossaryMarkdown({ children, glossary }: GlossaryMarkdownProps) {
  // The compiled index depends only on the glossary, so it memoises cleanly.
  const index = useMemo(() => buildGlossaryIndex(glossary ?? []), [glossary]);

  if (!index) return <Markdown>{children}</Markdown>;

  /**
   * Built on EVERY render, deliberately NOT memoised.
   *
   * `annotateChildren` mutates this set while rendering (each block records the terms it
   * consumed), so a memoised set would carry state across renders. React re-renders this
   * component for reasons that have nothing to do with the message — `QuestionnaireChat` owns the
   * composer's input state and renders the transcript in the same component, so every keystroke
   * re-renders every turn. With a memoised set the second render would find every term already
   * "seen" and drop all the underlines: they would appear once, then silently vanish the moment
   * the respondent started typing.
   *
   * Rebuilding per render is also what makes streaming correct — a partially-typed reply
   * re-annotates from scratch as tokens arrive. The cost is one Set and one regex scan per
   * message per render, trivial beside react-markdown's own parse.
   */
  const seen = new Set<string>();

  /**
   * Which block-level tags get annotated.
   *
   * `strong` and `em` are included deliberately: the interviewer bolds one phrase per message, and
   * a defined term landing inside that phrase must still carry its definition. `code`, `pre` and
   * `a` are absent by design — react-markdown hands their children to overrides as elements, not
   * strings, so `annotateChildren` structurally cannot reach inside them (see `annotate.tsx`).
   *
   * Written as an explicit literal rather than a loop: indexing `Components` by a tag union
   * produces a type TypeScript cannot represent, and every workaround needs a cast.
   *
   * `node` is react-markdown's mdast node — destructured off so it never reaches the DOM element,
   * which would otherwise warn about an unknown attribute on every annotated block.
   */
  const annotate = (kids: React.ReactNode) => annotateChildren(kids, index, seen);
  const components: Components = {
    p: ({ children: kids, node: _node, ...rest }) => <p {...rest}>{annotate(kids)}</p>,
    li: ({ children: kids, node: _node, ...rest }) => <li {...rest}>{annotate(kids)}</li>,
    strong: ({ children: kids, node: _node, ...rest }) => (
      <strong {...rest}>{annotate(kids)}</strong>
    ),
    em: ({ children: kids, node: _node, ...rest }) => <em {...rest}>{annotate(kids)}</em>,
    td: ({ children: kids, node: _node, ...rest }) => <td {...rest}>{annotate(kids)}</td>,
    th: ({ children: kids, node: _node, ...rest }) => <th {...rest}>{annotate(kids)}</th>,
    blockquote: ({ children: kids, node: _node, ...rest }) => (
      <blockquote {...rest}>{annotate(kids)}</blockquote>
    ),
  };

  return <Markdown components={components}>{children}</Markdown>;
}

/** Re-exported for the plain-text annotator, which needs the same index type. */
export type { GlossaryIndex };
