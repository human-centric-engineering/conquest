/**
 * Source-document view shape — the role narrowing (F17.29).
 *
 * Anti-green-bar: the one behaviour here is defensive, so it is asserted as behaviour rather than
 * as a passthrough. `narrowSourceDocumentRole` is what stands between a `role` column written by a
 * later build and this build feeding an unknown kind of document to the Routing Analyst. The
 * unrecognised-reads-as-`primary` rule is load-bearing in that direction specifically: `primary` is
 * the role every pre-column row has, and it is the role the analyst does NOT treat as a memo.
 *
 * @see lib/app/questionnaire/ingestion/source-documents.ts
 */

import { describe, it, expect } from 'vitest';

import { narrowSourceDocumentRole } from '@/lib/app/questionnaire/ingestion/source-documents';
import { SOURCE_DOCUMENT_ROLES } from '@/lib/app/questionnaire/constants';

describe('narrowSourceDocumentRole', () => {
  it('passes through the two roles this build understands', () => {
    expect(narrowSourceDocumentRole('primary')).toBe('primary');
    expect(narrowSourceDocumentRole('supplementary')).toBe('supplementary');
  });

  it('reads every role it does not recognise as primary, never as supplementary', () => {
    // A later build's role must not be quietly promoted into the analyst's reading list.
    for (const unknown of ['routing_memo', 'SUPPLEMENTARY', 'supplementary ', '', 'null']) {
      expect(narrowSourceDocumentRole(unknown)).toBe('primary');
    }
  });

  it('returns a role the constants list actually declares', () => {
    // Guards the pairing: if a third role is added to the union, the narrowing has to learn it
    // rather than silently keeping it out of reach.
    expect(SOURCE_DOCUMENT_ROLES).toContain(narrowSourceDocumentRole('supplementary'));
    expect(SOURCE_DOCUMENT_ROLES).toContain(narrowSourceDocumentRole('anything-else'));
  });
});
