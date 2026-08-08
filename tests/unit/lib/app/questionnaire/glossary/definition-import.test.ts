/**
 * Glossary in the definition export/import envelope — unit tests (P16).
 *
 * The import path is an EXTERNAL-DATA boundary: a definition file can be hand-edited or produced
 * by another tool, so it gets the same guards as the save path. Two of them exist because their
 * absence turns a bad request into a 500 or a silent data change:
 *
 *   - duplicate normalised terms would hit `@@unique([versionId, normalizedTerm])` mid-transaction
 *     as a P2002, aborting the whole import;
 *   - `edited` must survive the round-trip, or a later analysis re-run overwrites the hand-tuned
 *     wording it is meant to leave alone.
 *
 * @see lib/app/questionnaire/authoring/definition-export.ts
 */

import { describe, it, expect } from 'vitest';

import { definitionImportSchema } from '@/lib/app/questionnaire/authoring/definition-export';
import { GLOSSARY_MAX_TERMS_PER_VERSION } from '@/lib/app/questionnaire/glossary/types';

const DEFINITION_EXPORT_KIND = 'conquest.questionnaire.definition';

function envelope(glossary: unknown) {
  return {
    kind: DEFINITION_EXPORT_KIND,
    schemaVersion: 1,
    questionnaire: { title: 'Inner Work' },
    version: { goal: null, audience: null, tags: [], sections: [], glossary },
  };
}

function term(name: string, over: Record<string, unknown> = {}) {
  return {
    term: name,
    aliases: [],
    status: 'accepted',
    source: 'admin',
    definitions: [{ text: `Definition of ${name}.`, selected: true }],
    ...over,
  };
}

describe('definitionImportSchema — glossary', () => {
  it('imports a file with no glossary at all (pre-P16 export)', () => {
    const parsed = definitionImportSchema.parse(envelope(undefined));
    expect(parsed.version.glossary).toEqual([]);
  });

  it('round-trips the edited flag', () => {
    // Losing this lets the next analysis run overwrite the admin's own wording.
    const parsed = definitionImportSchema.parse(
      envelope([
        term('ego', {
          definitions: [
            { text: 'Hand-tuned.', selected: true, source: 'ai_proposed', edited: true },
          ],
        }),
      ])
    );
    expect(parsed.version.glossary[0].definitions[0].edited).toBe(true);
  });

  it('defaults edited to false so an older file still imports', () => {
    const parsed = definitionImportSchema.parse(envelope([term('ego')]));
    expect(parsed.version.glossary[0].definitions[0].edited).toBe(false);
  });

  it('rejects two terms that normalise to the same surface', () => {
    // Would otherwise reach the DB and abort the transaction with a P2002 → 500.
    const result = definitionImportSchema.safeParse(
      envelope([term('higher-self'), term('Higher Self')])
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.message.includes('Duplicate glossary term'));
    expect(issue).toBeTruthy();
    // Flagged on the repeat, not on the term that got there first.
    expect(issue?.path.join('.')).toContain('1');
  });

  it('allows two genuinely distinct terms that share a word', () => {
    const result = definitionImportSchema.safeParse(envelope([term('higher self'), term('self')]));
    expect(result.success).toBe(true);
  });

  it('enforces the per-version term cap', () => {
    const many = Array.from({ length: GLOSSARY_MAX_TERMS_PER_VERSION + 1 }, (_, i) =>
      term(`term ${i}`)
    );
    expect(definitionImportSchema.safeParse(envelope(many)).success).toBe(false);

    const atCap = Array.from({ length: GLOSSARY_MAX_TERMS_PER_VERSION }, (_, i) =>
      term(`term ${i}`)
    );
    expect(definitionImportSchema.safeParse(envelope(atCap)).success).toBe(true);
  });

  it('rejects an unknown status rather than importing an unrenderable term', () => {
    expect(
      definitionImportSchema.safeParse(envelope([term('ego', { status: 'maybe' })])).success
    ).toBe(false);
  });
});
