/**
 * Glossary report appendix — unit tests (P16).
 *
 * Taking the config switch as an argument (rather than checking it at each render site) means one
 * pure function decides whether the screen, the paper layout and the PDF all show the appendix.
 * These tests are what stop those three drifting apart.
 *
 * @see lib/app/questionnaire/glossary/report-appendix.ts
 */

import { describe, it, expect } from 'vitest';

import {
  GLOSSARY_APPENDIX_HEADING,
  buildGlossaryAppendix,
} from '@/lib/app/questionnaire/glossary/report-appendix';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

function entry(termId: string, term: string, definitions: string[]): GlossaryEntry {
  return { termId, term, surfaces: [term], definitions };
}

const HIGHER_SELF = entry('t-hs', 'higher self', ['The observing, values-led part of you.']);
const EGO = entry('t-ego', 'ego', ['The constructed self.', 'The Jungian conscious centre.']);

describe('buildGlossaryAppendix', () => {
  it('builds the appendix from the accepted terms', () => {
    const appendix = buildGlossaryAppendix([HIGHER_SELF, EGO]);
    expect(appendix).not.toBeNull();
    expect(appendix?.heading).toBe(GLOSSARY_APPENDIX_HEADING);
    expect(appendix?.entries).toHaveLength(2);
    expect(appendix?.entries[0]).toEqual({
      term: 'higher self',
      definitions: ['The observing, values-led part of you.'],
    });
  });

  it('keeps several senses as separate entries rather than merging them', () => {
    const appendix = buildGlossaryAppendix([EGO]);
    expect(appendix?.entries[0].definitions).toEqual([
      'The constructed self.',
      'The Jungian conscious centre.',
    ]);
  });

  it('returns null when disabled, even with terms to show', () => {
    // The admin's `glossaryReportAppendix` switch — off by default, because it changes a
    // delivered document.
    expect(buildGlossaryAppendix([HIGHER_SELF, EGO], false)).toBeNull();
  });

  it('returns null for an empty set — no heading with nothing under it', () => {
    expect(buildGlossaryAppendix([])).toBeNull();
  });

  it('drops a term whose definitions are all blank, and returns null if that empties it', () => {
    expect(buildGlossaryAppendix([entry('t-b', 'ego', ['  ', ''])])).toBeNull();
    const mixed = buildGlossaryAppendix([entry('t-b', 'ego', ['  ']), HIGHER_SELF]);
    expect(mixed?.entries.map((e) => e.term)).toEqual(['higher self']);
  });

  it('trims definition whitespace', () => {
    const appendix = buildGlossaryAppendix([entry('t-t', 'ego', ['  The constructed self.  '])]);
    expect(appendix?.entries[0].definitions).toEqual(['The constructed self.']);
  });

  it('preserves the admin ordering', () => {
    const appendix = buildGlossaryAppendix([EGO, HIGHER_SELF]);
    expect(appendix?.entries.map((e) => e.term)).toEqual(['ego', 'higher self']);
  });
});
