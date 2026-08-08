'use client';

/**
 * Plain-text glossary annotation (P16) — for surfaces that render text, not markdown.
 *
 * The form-mode question label is the motivating case: it renders `slot.prompt` verbatim, so it
 * needs the underline without a markdown pass.
 *
 * Each `<GlossaryText>` carries its own `seen` set, so "first occurrence only" is scoped to that
 * one label — the right unit here, since two form fields that both use a term should each explain
 * it (unlike two paragraphs of one chat message, which are read together).
 */

import { useMemo } from 'react';

import { annotateString } from '@/components/app/questionnaire/glossary/annotate';
import { buildGlossaryIndex } from '@/lib/app/questionnaire/glossary/matcher';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

export interface GlossaryTextProps {
  text: string;
  /** The version's live glossary. Empty/absent → the text is returned verbatim. */
  glossary?: readonly GlossaryEntry[];
}

export function GlossaryText({ text, glossary }: GlossaryTextProps) {
  const annotated = useMemo(() => {
    const index = buildGlossaryIndex(glossary ?? []);
    if (!index) return text;
    return annotateString(text, index, new Set<string>());
  }, [text, glossary]);

  return <>{annotated}</>;
}
