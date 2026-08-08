/**
 * Glossary editor working shapes — unit tests (P16).
 *
 * `toSavePayload` is the boundary between the editor's in-memory state and the replace-set PUT.
 * Two behaviours matter: it must not send a blank definition the admin abandoned (the save schema
 * rejects those as a hard error), and it must preserve the `edited` / `source` provenance that
 * decides whether a later analysis re-run leaves a hand-tuned definition alone.
 *
 * @see components/admin/questionnaires/glossary/glossary-types.ts
 */

import { describe, it, expect } from 'vitest';

import {
  blankTerm,
  toDraftTerm,
  toSavePayload,
} from '@/components/admin/questionnaires/glossary/glossary-types';
import type { GlossaryTermView } from '@/lib/app/questionnaire/glossary';

function view(over: Partial<GlossaryTermView> = {}): GlossaryTermView {
  return {
    id: 'term-1',
    term: 'higher self',
    normalizedTerm: 'higher self',
    aliases: ['higher-self'],
    status: 'accepted',
    source: 'ai_proposed',
    rationale: 'Contested across traditions.',
    contextQuote: 'How connected do you feel?',
    ordinal: 0,
    definitions: [
      {
        id: 'def-1',
        text: 'The observing part of you.',
        selected: true,
        source: 'ai_proposed',
        sourceQuote: null,
        edited: false,
        ordinal: 0,
      },
    ],
    ...over,
  };
}

describe('toDraftTerm', () => {
  it('carries the server view through, stamping stable client ids', () => {
    const draft = toDraftTerm(view());
    expect(draft).toMatchObject({
      term: 'higher self',
      status: 'accepted',
      source: 'ai_proposed',
      rationale: 'Contested across traditions.',
    });
    // Stable React keys, so editing a term's text doesn't remount its card mid-keystroke.
    expect(draft.id).toMatch(/^term-\d+$/);
    expect(draft.definitions[0].id).toMatch(/^def-\d+$/);
  });

  it('gives every term and definition a distinct client id', () => {
    const a = toDraftTerm(view());
    const b = toDraftTerm(view());
    expect(a.id).not.toBe(b.id);
    expect(a.definitions[0].id).not.toBe(b.definitions[0].id);
  });
});

describe('blankTerm', () => {
  it('starts as an admin-authored accepted term with one ticked, empty definition', () => {
    const term = blankTerm();
    expect(term).toMatchObject({ term: '', status: 'accepted', source: 'admin' });
    expect(term.definitions).toHaveLength(1);
    expect(term.definitions[0]).toMatchObject({ text: '', selected: true, source: 'admin' });
  });
});

describe('toSavePayload', () => {
  it('trims the term and its aliases', () => {
    const draft = toDraftTerm(view({ term: '  higher self  ', aliases: ['  HS  ', ''] }));
    expect(toSavePayload([draft])[0]).toMatchObject({ term: 'higher self', aliases: ['HS'] });
  });

  it('drops a definition the admin added and then abandoned', () => {
    // An empty row is an "Add a definition" they thought better of. Sending it would fail the
    // save schema outright rather than quietly ignoring something already abandoned.
    const draft = toDraftTerm(view());
    draft.definitions.push({
      id: 'def-blank',
      text: '   ',
      selected: false,
      source: 'admin',
      sourceQuote: null,
      edited: false,
    });
    expect(toSavePayload([draft])[0].definitions).toHaveLength(1);
  });

  it('preserves the edited flag and source, which govern a later re-run', () => {
    const draft = toDraftTerm(
      view({
        definitions: [
          {
            id: 'def-1',
            text: 'Hand-tuned wording.',
            selected: true,
            source: 'ai_proposed',
            sourceQuote: null,
            edited: true,
            ordinal: 0,
          },
        ],
      })
    );
    expect(toSavePayload([draft])[0].definitions[0]).toMatchObject({
      text: 'Hand-tuned wording.',
      edited: true,
      source: 'ai_proposed',
    });
  });

  it('keeps a document sourceQuote so its provenance survives a save', () => {
    const draft = toDraftTerm(
      view({
        definitions: [
          {
            id: 'def-1',
            text: 'From the handbook.',
            selected: true,
            source: 'document',
            sourceQuote: 'the Self that observes',
            edited: false,
            ordinal: 0,
          },
        ],
      })
    );
    expect(toSavePayload([draft])[0].definitions[0]).toMatchObject({
      source: 'document',
      sourceQuote: 'the Self that observes',
    });
  });

  it('preserves array order — ordinals are derived from it server-side', () => {
    const a = toDraftTerm(view({ term: 'alpha' }));
    const b = toDraftTerm(view({ term: 'beta' }));
    expect(toSavePayload([b, a]).map((t) => t.term)).toEqual(['beta', 'alpha']);
  });

  it('round-trips a rejected term, so a re-run does not re-propose it', () => {
    const draft = toDraftTerm(view({ status: 'rejected' }));
    expect(toSavePayload([draft])[0].status).toBe('rejected');
  });
});
