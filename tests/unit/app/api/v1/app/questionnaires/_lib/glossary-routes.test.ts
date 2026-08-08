/**
 * Glossary route DB seam — unit tests (P16).
 *
 * The route-level integration tests MOCK this module, so without this file its logic never runs.
 * That logic carries the invariant the whole feature's re-runnability rests on:
 *
 *   **`persistProposedTerms` must never re-raise a decision the admin has already made.**
 *
 * Prisma and the transaction helper are mocked at the module boundary; the assertions are about
 * the rows this seam decides to write, not about the mocks.
 *
 * @see app/api/v1/app/questionnaires/_lib/glossary-routes.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  term: { findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  document: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  version: { findFirst: vi.fn() },
  tx: {
    appGlossaryTerm: { deleteMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appGlossaryTerm: mocks.term,
    appGlossaryDocument: mocks.document,
    appQuestionnaireVersion: mocks.version,
  },
}));
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(mocks.tx)),
}));

import {
  buildGlossaryAnalysisInput,
  deleteGlossaryDocument,
  deleteProposedGlossaryTerms,
  loadGlossaryDocument,
  loadGlossaryForExport,
  loadGlossaryPublishTarget,
  loadGlossaryTerms,
  upsertGlossaryDocument,
  persistProposedTerms,
  renderGlossaryKnowledgeDocument,
  replaceGlossaryTerms,
  toGlossaryTermView,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';

/** Every `create` payload written inside the transaction, in order. */
function createdTerms() {
  return mocks.tx.appGlossaryTerm.create.mock.calls.map((c) => c[0].data);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.term.findMany.mockResolvedValue([]);
  mocks.tx.appGlossaryTerm.create.mockResolvedValue({ id: 'new' });
  mocks.term.deleteMany.mockResolvedValue({ count: 0 });
});

describe('toGlossaryTermView', () => {
  const row = {
    id: 't-1',
    term: 'higher self',
    normalizedTerm: 'higher self',
    aliases: ['higher-self'],
    status: 'accepted',
    source: 'ai_proposed',
    rationale: null,
    contextQuote: null,
    ordinal: 0,
    definitions: [
      {
        id: 'd-1',
        text: 'A definition.',
        selected: true,
        source: 'document',
        sourceQuote: 'a quote',
        edited: false,
        ordinal: 0,
      },
    ],
  };

  it('projects a row into the client-safe view', () => {
    expect(toGlossaryTermView(row)).toMatchObject({
      id: 't-1',
      term: 'higher self',
      aliases: ['higher-self'],
      status: 'accepted',
      definitions: [{ text: 'A definition.', source: 'document', sourceQuote: 'a quote' }],
    });
  });

  it('degrades a non-array aliases column to none rather than throwing', () => {
    // The column is `Json`; a malformed row must not blow up the admin surface.
    expect(toGlossaryTermView({ ...row, aliases: 'nope' }).aliases).toEqual([]);
    expect(toGlossaryTermView({ ...row, aliases: [1, 'ok', null] }).aliases).toEqual(['ok']);
  });
});

describe('replaceGlossaryTerms', () => {
  beforeEach(() => {
    mocks.term.findMany.mockResolvedValue([]);
  });

  it('clears the version and rewrites the set with array-order ordinals', async () => {
    await replaceGlossaryTerms(
      'ver-1',
      [
        { term: 'alpha', aliases: [], status: 'accepted', source: 'admin', definitions: [] },
        { term: 'beta', aliases: [], status: 'rejected', source: 'admin', definitions: [] },
      ],
      'admin-1'
    );

    expect(mocks.tx.appGlossaryTerm.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-1' },
    });
    expect(createdTerms().map((d) => [d.term, d.ordinal])).toEqual([
      ['alpha', 0],
      ['beta', 1],
    ]);
  });

  it('drops an alias that merely restates the term', async () => {
    // A redundant surface adds an alternation branch to the matcher for no extra match.
    await replaceGlossaryTerms(
      'ver-1',
      [
        {
          term: 'higher self',
          aliases: ['higher-self', 'HS', 'HS'],
          status: 'accepted',
          source: 'admin',
          definitions: [],
        },
      ],
      null
    );
    expect(createdTerms()[0].aliases).toEqual(['HS']);
  });

  it('stores the normalised surface as the uniqueness key', async () => {
    await replaceGlossaryTerms(
      'ver-1',
      [{ term: 'Higher-Self', aliases: [], status: 'accepted', source: 'admin', definitions: [] }],
      null
    );
    expect(createdTerms()[0]).toMatchObject({
      term: 'Higher-Self',
      normalizedTerm: 'higher self',
    });
  });

  it('omits createdBy when there is no attributed admin', async () => {
    await replaceGlossaryTerms(
      'ver-1',
      [{ term: 'ego', aliases: [], status: 'accepted', source: 'admin', definitions: [] }],
      null
    );
    expect(createdTerms()[0]).not.toHaveProperty('createdBy');
  });
});

describe('persistProposedTerms — the re-run invariant', () => {
  const proposal = (term: string, over: Record<string, unknown> = {}) => ({
    term,
    aliases: [],
    rationale: 'because',
    definitions: [{ text: `Definition of ${term}.` }],
    ...over,
  });

  it('replaces only the proposals, leaving adjudications untouched', async () => {
    mocks.term.findMany.mockResolvedValue([]);
    await persistProposedTerms('ver-1', [proposal('ego')], 'admin-1');

    expect(mocks.tx.appGlossaryTerm.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', status: 'proposed' },
    });
  });

  it('drops a proposal the admin already accepted or rejected, and counts it', async () => {
    // The entire reason a re-run is safe: a settled decision is never re-raised.
    mocks.term.findMany.mockResolvedValue([
      { normalizedTerm: 'ego', status: 'rejected' },
      { normalizedTerm: 'higher self', status: 'accepted' },
    ]);

    const result = await persistProposedTerms(
      'ver-1',
      [proposal('Ego'), proposal('higher-self'), proposal('shadow')],
      'admin-1'
    );

    expect(result).toMatchObject({
      proposedCount: 1,
      skippedExistingCount: 2,
      acceptedCount: 1,
    });
    expect(createdTerms().map((d) => d.term)).toEqual(['shadow']);
  });

  it('collapses duplicates within one run, which the unique index would otherwise reject', async () => {
    const result = await persistProposedTerms(
      'ver-1',
      [proposal('ego'), proposal('Ego'), proposal('EGO')],
      null
    );
    expect(result.proposedCount).toBe(1);
    expect(createdTerms()).toHaveLength(1);
  });

  it('writes proposals UNTICKED, so accepting is always a deliberate choice of reading', async () => {
    await persistProposedTerms('ver-1', [proposal('ego')], null);
    expect(createdTerms()[0].definitions.create[0].selected).toBe(false);
    expect(createdTerms()[0].status).toBe('proposed');
    expect(createdTerms()[0].source).toBe('ai_proposed');
  });

  it('marks a definition as document-sourced exactly when it carries a quote', async () => {
    await persistProposedTerms(
      'ver-1',
      [
        proposal('ego', {
          definitions: [
            { text: 'Inferred.' },
            { text: 'From the handbook.', sourceQuote: 'the observing Self' },
          ],
        }),
      ],
      null
    );
    const defs = createdTerms()[0].definitions.create;
    expect(defs[0]).toMatchObject({ source: 'ai_proposed' });
    expect(defs[0]).not.toHaveProperty('sourceQuote');
    expect(defs[1]).toMatchObject({ source: 'document', sourceQuote: 'the observing Self' });
  });

  it('skips a proposal whose term normalises to nothing', async () => {
    const result = await persistProposedTerms('ver-1', [proposal('---')], null);
    expect(result.proposedCount).toBe(0);
    expect(mocks.tx.appGlossaryTerm.create).not.toHaveBeenCalled();
  });

  it('still clears stale proposals when the analyst returns nothing', async () => {
    const result = await persistProposedTerms('ver-1', [], null);
    expect(mocks.tx.appGlossaryTerm.deleteMany).toHaveBeenCalled();
    expect(result.proposedCount).toBe(0);
  });
});

describe('buildGlossaryAnalysisInput', () => {
  const version = (over: Record<string, unknown> = {}) => ({
    goal: 'Assess development',
    audience: null,
    sections: [
      {
        title: 'Inner life',
        questions: [{ key: 'q1', prompt: 'Your higher self?', guidelines: 'Probe gently.' }],
      },
    ],
    dataSlots: [{ name: 'Practice' }],
    glossaryDocument: null,
    glossaryTerms: [{ term: 'shadow' }],
    ...over,
  });

  it('flattens the questions and carries the already-adjudicated terms', async () => {
    mocks.version.findFirst.mockResolvedValue(version());
    const input = await buildGlossaryAnalysisInput('qn-1', 'ver-1');

    expect(input).toMatchObject({
      goal: 'Assess development',
      dataSlotNames: ['Practice'],
      existingTerms: ['shadow'],
    });
    expect(input?.questions[0]).toMatchObject({
      key: 'q1',
      prompt: 'Your higher self?',
      guidelines: 'Probe gently.',
      sectionTitle: 'Inner life',
    });
  });

  it('asks only for adjudicated terms — a still-proposed one is fair game to re-raise', async () => {
    mocks.version.findFirst.mockResolvedValue(version());
    await buildGlossaryAnalysisInput('qn-1', 'ver-1');
    const arg = mocks.version.findFirst.mock.calls[0][0];
    expect(arg.select.glossaryTerms.where).toEqual({ status: { in: ['accepted', 'rejected'] } });
  });

  it('includes the document TEXT when one is attached', async () => {
    mocks.version.findFirst.mockResolvedValue(
      version({ glossaryDocument: { fileName: 'g.pdf', extractedText: 'Higher self: …' } })
    );
    const input = await buildGlossaryAnalysisInput('qn-1', 'ver-1');
    expect(input).toMatchObject({ documentFileName: 'g.pdf', documentText: 'Higher self: …' });
  });

  it('returns null for a version with no questions — an empty run would bill for nothing', async () => {
    mocks.version.findFirst.mockResolvedValue(version({ sections: [] }));
    expect(await buildGlossaryAnalysisInput('qn-1', 'ver-1')).toBeNull();
  });

  it('returns null when the id pair does not resolve', async () => {
    mocks.version.findFirst.mockResolvedValue(null);
    expect(await buildGlossaryAnalysisInput('qn-1', 'nope')).toBeNull();
  });
});

describe('loadGlossaryDocument', () => {
  it('reports the text LENGTH, never the text itself', async () => {
    mocks.document.findUnique.mockResolvedValue({
      id: 'doc-1',
      fileName: 'g.pdf',
      byteSize: 10,
      mimeType: 'application/pdf',
      extractedText: 'secret handbook contents',
      createdAt: new Date('2026-01-01'),
    });

    const view = await loadGlossaryDocument('ver-1');
    expect(view).toMatchObject({ fileName: 'g.pdf', textLength: 24 });
    expect(JSON.stringify(view)).not.toContain('secret handbook');
  });

  it('returns null when the version has no document', async () => {
    mocks.document.findUnique.mockResolvedValue(null);
    expect(await loadGlossaryDocument('ver-1')).toBeNull();
  });
});

describe('renderGlossaryKnowledgeDocument', () => {
  const target = {
    questionnaireTitle: 'Inner Work',
    versionNumber: 3,
    demoClientId: 'c-1',
    demoClientName: 'Acme',
    acceptedTermCount: 1,
  };

  it('leads with a scope line — the only disambiguator retrieval gets', () => {
    const md = renderGlossaryKnowledgeDocument(target, [
      { term: 'ego', definitions: ['One sense.'] },
    ]);
    expect(md).toContain('# Glossary — Inner Work (v3)');
    expect(md).toContain('These definitions apply to the questionnaire "Inner Work"');
    expect(md).toContain('may not hold for other questionnaires');
  });

  it('numbers several senses rather than merging them', () => {
    const md = renderGlossaryKnowledgeDocument(target, [
      { term: 'ego', definitions: ['First.', 'Second.'] },
    ]);
    expect(md).toContain('more than one sense');
    expect(md).toContain('1. First.');
    expect(md).toContain('2. Second.');
  });

  it('renders a single definition as plain prose under its heading', () => {
    const md = renderGlossaryKnowledgeDocument(target, [{ term: 'ego', definitions: ['Only.'] }]);
    expect(md).toContain('## ego');
    expect(md).toContain('Only.');
    expect(md).not.toContain('more than one sense');
  });
});

/* -------------------------------------------------------------------------- */
/* The remaining exported seam functions                                      */
/* -------------------------------------------------------------------------- */

describe('loadGlossaryTerms', () => {
  it('reads the version in ordinal order and projects every row', async () => {
    mocks.term.findMany.mockResolvedValue([
      {
        id: 't-1',
        term: 'ego',
        normalizedTerm: 'ego',
        aliases: [],
        status: 'accepted',
        source: 'admin',
        rationale: null,
        contextQuote: null,
        ordinal: 0,
        definitions: [],
      },
    ]);

    const terms = await loadGlossaryTerms('ver-1');
    expect(mocks.term.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'ver-1' }, orderBy: { ordinal: 'asc' } })
    );
    expect(terms).toHaveLength(1);
    expect(terms[0].term).toBe('ego');
  });

  it('reads EVERY status — the review queue shows proposals and rejections too', async () => {
    mocks.term.findMany.mockResolvedValue([]);
    await loadGlossaryTerms('ver-1');
    // Unlike the runtime resolver, the admin surface must not filter to `accepted`.
    expect(mocks.term.findMany.mock.calls[0][0].where).toEqual({ versionId: 'ver-1' });
  });
});

describe('deleteProposedGlossaryTerms', () => {
  it('retires only the proposals, never an adjudicated term', async () => {
    mocks.term.deleteMany.mockResolvedValue({ count: 3 });
    await deleteProposedGlossaryTerms('ver-1');
    expect(mocks.term.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', status: 'proposed' },
    });
  });
});

describe('upsertGlossaryDocument', () => {
  const doc = {
    fileName: 'g.pdf',
    fileHash: 'sha-1',
    byteSize: 100,
    mimeType: 'application/pdf',
    extractedText: 'Higher self: the observing Self.',
  };

  beforeEach(() => {
    mocks.document.upsert.mockResolvedValue({
      id: 'doc-1',
      fileName: 'g.pdf',
      byteSize: 100,
      mimeType: 'application/pdf',
      extractedText: doc.extractedText,
      createdAt: new Date('2026-01-01'),
    });
  });

  it('upserts on versionId — a second upload replaces rather than accumulating', async () => {
    await upsertGlossaryDocument('ver-1', doc, 'admin-1');
    const arg = mocks.document.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ versionId: 'ver-1' });
    expect(arg.create).toMatchObject({
      versionId: 'ver-1',
      fileName: 'g.pdf',
      uploadedBy: 'admin-1',
    });
    expect(arg.update).toMatchObject({ fileName: 'g.pdf' });
  });

  it('omits the null optionals rather than writing them', async () => {
    await upsertGlossaryDocument('ver-1', { ...doc, mimeType: null }, null);
    const arg = mocks.document.upsert.mock.calls[0][0];
    expect(arg.create).not.toHaveProperty('mimeType');
    expect(arg.create).not.toHaveProperty('uploadedBy');
  });

  it('returns the view with a text LENGTH, never the text', async () => {
    const view = await upsertGlossaryDocument('ver-1', doc, 'admin-1');
    expect(view).toMatchObject({
      id: 'doc-1',
      fileName: 'g.pdf',
      textLength: doc.extractedText.length,
    });
    expect(JSON.stringify(view)).not.toContain('observing Self');
  });
});

describe('deleteGlossaryDocument', () => {
  it('detaches by version and is a no-op when there is none', async () => {
    mocks.document.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteGlossaryDocument('ver-1')).resolves.toBeUndefined();
    expect(mocks.document.deleteMany).toHaveBeenCalledWith({ where: { versionId: 'ver-1' } });
  });
});

describe('loadGlossaryForExport', () => {
  it('exports EVERY status — a rejection is a decision worth carrying', async () => {
    mocks.term.findMany.mockResolvedValue([
      {
        term: 'ego',
        aliases: ['e'],
        status: 'rejected',
        source: 'ai_proposed',
        rationale: 'why',
        contextQuote: null,
        definitions: [
          {
            text: 'A definition.',
            selected: false,
            source: 'ai_proposed',
            sourceQuote: null,
            edited: true,
          },
        ],
      },
    ]);

    const exported = await loadGlossaryForExport('ver-1');
    // No status filter — re-importing elsewhere must not resurrect a rejected term as a proposal.
    expect(mocks.term.findMany.mock.calls[0][0].where).toEqual({ versionId: 'ver-1' });
    expect(exported[0]).toMatchObject({ term: 'ego', status: 'rejected', aliases: ['e'] });
    expect(exported[0].definitions[0]).toMatchObject({ text: 'A definition.', selected: false });
    // `edited` must survive the round-trip: a later analysis re-run leaves an edited definition
    // alone, so losing the flag on import would let the next run overwrite the admin's wording.
    expect(exported[0].definitions[0].edited).toBe(true);
    expect(mocks.term.findMany.mock.calls[0][0].select.definitions.select.edited).toBe(true);
  });

  it('degrades a malformed aliases column to none', async () => {
    mocks.term.findMany.mockResolvedValue([
      {
        term: 'ego',
        aliases: null,
        status: 'accepted',
        source: 'admin',
        rationale: null,
        contextQuote: null,
        definitions: [],
      },
    ]);
    expect((await loadGlossaryForExport('ver-1'))[0].aliases).toEqual([]);
  });
});

describe('loadGlossaryPublishTarget', () => {
  it('resolves the client attribution and the accepted-term count', async () => {
    mocks.version.findFirst.mockResolvedValue({
      versionNumber: 3,
      questionnaire: { title: 'Inner Work', demoClientId: 'c-1', demoClient: { name: 'Acme' } },
      _count: { glossaryTerms: 2 },
    });

    const target = await loadGlossaryPublishTarget('qn-1', 'ver-1');
    expect(target).toEqual({
      questionnaireTitle: 'Inner Work',
      versionNumber: 3,
      demoClientId: 'c-1',
      demoClientName: 'Acme',
      acceptedTermCount: 2,
    });
  });

  it('reports a null client rather than failing — the route turns that into a clear 409', async () => {
    mocks.version.findFirst.mockResolvedValue({
      versionNumber: 1,
      questionnaire: { title: 'Unattributed', demoClientId: null, demoClient: null },
      _count: { glossaryTerms: 0 },
    });

    const target = await loadGlossaryPublishTarget('qn-1', 'ver-1');
    expect(target).toMatchObject({ demoClientId: null, demoClientName: null });
  });

  it('counts only ACCEPTED terms — proposals are not publishable', async () => {
    mocks.version.findFirst.mockResolvedValue({
      versionNumber: 1,
      questionnaire: { title: 'X', demoClientId: 'c-1', demoClient: { name: 'A' } },
      _count: { glossaryTerms: 0 },
    });
    await loadGlossaryPublishTarget('qn-1', 'ver-1');
    const arg = mocks.version.findFirst.mock.calls[0][0];
    expect(arg.select._count.select.glossaryTerms.where).toEqual({ status: 'accepted' });
  });

  it('returns null when the id pair does not resolve', async () => {
    mocks.version.findFirst.mockResolvedValue(null);
    expect(await loadGlossaryPublishTarget('qn-1', 'nope')).toBeNull();
  });
});
