/**
 * Glossary resolver — unit tests (P16).
 *
 * Three behaviours carry weight here:
 *
 *   1. **The curation gate.** Only `accepted` terms with at least one SELECTED definition are
 *      live. A term whose readings were all unticked must be dropped, never surfaced with an empty
 *      popover.
 *   2. **The config switches are independent.** Hints and prompt injection read different columns,
 *      so an admin can have definitions guiding the agents without steering respondents, or the
 *      reverse.
 *   3. **Fail-soft.** The glossary enriches a turn; it does not enable one. A DB failure must
 *      degrade to "no definitions", never break the conversation.
 *
 * @see lib/app/questionnaire/glossary/resolve.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findUnique: mocks.findUnique } },
}));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));

import {
  loadAcceptedGlossaryEntries,
  resolveGlossaryAppendixForVersion,
  resolveGlossaryForHints,
  resolveGlossaryForPrompts,
} from '@/lib/app/questionnaire/glossary/resolve';

/** A row as the resolver's `select` shapes it. */
function row(over: Record<string, unknown> = {}) {
  return {
    config: { glossaryPromptInjection: true, glossaryRespondentHints: true },
    glossaryTerms: [
      {
        id: 't-hs',
        term: 'higher self',
        aliases: ['higher-self'],
        definitions: [{ text: 'The observing, values-led part of you.' }],
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(row());
});

describe('resolveGlossaryForPrompts / ForHints', () => {
  it('projects a term into the matcher shape with normalised surfaces', async () => {
    const entries = await resolveGlossaryForPrompts('ver-1');
    expect(entries).toEqual([
      {
        termId: 't-hs',
        term: 'higher self',
        // Both spellings are normalised server-side, so the client never re-derives them — and
        // "higher-self" folds onto "higher self", leaving one surface, not two.
        surfaces: ['higher self'],
        definitions: ['The observing, values-led part of you.'],
      },
    ]);
  });

  it('keeps a genuinely distinct alias as its own surface', async () => {
    mocks.findUnique.mockResolvedValue(
      row({
        glossaryTerms: [
          {
            id: 't-hs',
            term: 'higher self',
            aliases: ['HS'],
            definitions: [{ text: 'A definition.' }],
          },
        ],
      })
    );
    const [entry] = await resolveGlossaryForPrompts('ver-1');
    expect(entry.surfaces).toEqual(['higher self', 'hs']);
  });

  it('drops a term whose definitions were all unticked', async () => {
    // Would otherwise underline to a respondent and open an empty popover.
    mocks.findUnique.mockResolvedValue(
      row({
        glossaryTerms: [{ id: 't-x', term: 'ego', aliases: [], definitions: [] }],
      })
    );
    expect(await resolveGlossaryForPrompts('ver-1')).toEqual([]);
  });

  it('asks only for accepted terms and selected definitions', async () => {
    await resolveGlossaryForPrompts('ver-1');
    const arg = mocks.findUnique.mock.calls[0][0];
    expect(arg.select.glossaryTerms.where).toEqual({ status: 'accepted' });
    expect(arg.select.glossaryTerms.select.definitions.where).toEqual({ selected: true });
  });

  it('returns [] when the version does not resolve', async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await resolveGlossaryForPrompts('nope')).toEqual([]);
  });

  it('reads a DIFFERENT column for each surface, so the switches are independent', async () => {
    await resolveGlossaryForPrompts('ver-1');
    await resolveGlossaryForHints('ver-1');
    expect(mocks.findUnique.mock.calls[0][0].select.config.select).toEqual({
      glossaryPromptInjection: true,
    });
    expect(mocks.findUnique.mock.calls[1][0].select.config.select).toEqual({
      glossaryRespondentHints: true,
    });
  });

  it('returns [] when its own switch is off, even with accepted terms', async () => {
    mocks.findUnique.mockResolvedValue(row({ config: { glossaryPromptInjection: false } }));
    expect(await resolveGlossaryForPrompts('ver-1')).toEqual([]);
  });

  it('falls back to the default when the version has no config row (lazy 1:1)', async () => {
    mocks.findUnique.mockResolvedValue(row({ config: null }));
    // Prompt injection defaults ON, so an admin who never opened the tab still gets it.
    expect(await resolveGlossaryForPrompts('ver-1')).toHaveLength(1);
  });

  it('tolerates a non-array aliases column rather than throwing', async () => {
    mocks.findUnique.mockResolvedValue(
      row({
        glossaryTerms: [
          {
            id: 't-x',
            term: 'ego',
            aliases: 'not-an-array',
            definitions: [{ text: 'A definition.' }],
          },
        ],
      })
    );
    const [entry] = await resolveGlossaryForPrompts('ver-1');
    expect(entry.surfaces).toEqual(['ego']);
  });
});

describe('fail-soft', () => {
  it('degrades to no definitions and warns when the read throws', async () => {
    // The glossary ENRICHES a turn; it does not enable one. A DB blip must not break the
    // respondent's conversation or the report that follows.
    mocks.findUnique.mockRejectedValue(new Error('connection lost'));

    expect(await resolveGlossaryForPrompts('ver-1')).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Glossary unavailable'),
      expect.objectContaining({ versionId: 'ver-1', gate: 'glossaryPromptInjection' })
    );
  });

  it('does not throw out of the appendix resolver either', async () => {
    mocks.findUnique.mockRejectedValue(new Error('connection lost'));
    expect(await resolveGlossaryAppendixForVersion('ver-1')).toBeNull();
  });
});

describe('resolveGlossaryAppendixForVersion', () => {
  it('builds the appendix from accepted terms, gated on its own switch', async () => {
    mocks.findUnique.mockResolvedValue(row({ config: { glossaryReportAppendix: true } }));
    const appendix = await resolveGlossaryAppendixForVersion('ver-1');
    expect(appendix?.entries).toEqual([
      { term: 'higher self', definitions: ['The observing, values-led part of you.'] },
    ]);
  });

  it('returns null when the report-appendix switch is off (the default)', async () => {
    mocks.findUnique.mockResolvedValue(row({ config: { glossaryReportAppendix: false } }));
    expect(await resolveGlossaryAppendixForVersion('ver-1')).toBeNull();
  });

  it('defaults OFF when there is no config row — it changes a delivered document', async () => {
    mocks.findUnique.mockResolvedValue(row({ config: null }));
    expect(await resolveGlossaryAppendixForVersion('ver-1')).toBeNull();
  });
});

describe('loadAcceptedGlossaryEntries — the ungated export read', () => {
  it('asks for NO config column at all', async () => {
    await loadAcceptedGlossaryEntries('ver-1');
    // The export surfaces are gated by `glossaryReportAppendix` (applied by the caller) or not at
    // all — never by prompt injection.
    expect(mocks.findUnique.mock.calls[0][0].select).not.toHaveProperty('config');
  });

  it('returns the accepted terms even when EVERY config switch is off', async () => {
    // The regression this guards: reading the blank instrument or the report PDF through
    // `resolveGlossaryForPrompts` meant an admin who turned prompt injection off silently lost
    // the glossary from the reviewer's export, and made the PDF disagree with the on-screen
    // appendix — the disagreement `buildGlossaryAppendix` exists to make impossible.
    mocks.findUnique.mockResolvedValue(
      row({
        config: {
          glossaryPromptInjection: false,
          glossaryRespondentHints: false,
          glossaryReportAppendix: false,
        },
      })
    );
    expect(await loadAcceptedGlossaryEntries('ver-1')).toHaveLength(1);
  });

  it('still returns [] when the version has nothing accepted', async () => {
    mocks.findUnique.mockResolvedValue(row({ glossaryTerms: [] }));
    expect(await loadAcceptedGlossaryEntries('ver-1')).toEqual([]);
  });

  it('is fail-soft like the gated readers', async () => {
    mocks.findUnique.mockRejectedValue(new Error('connection lost'));
    expect(await loadAcceptedGlossaryEntries('ver-1')).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Glossary unavailable'),
      expect.objectContaining({ gate: 'none' })
    );
  });
});
