/**
 * Unit tests for lib/privacy/export-user.ts
 *
 * Contract under test:
 *   exportUserData({ userId, actorUserId, reason })
 *   1. throws SubjectNotFoundError when there is no account row
 *   2. runs every manifest source and files it by disposition
 *   3. folds in erasure receipts and the app seam
 *   4. reports scope honestly in `meta` (counts, exclusions, format version)
 *   5. fails whole rather than returning a partial bundle
 *
 * The redaction cases assert the arguments that reach Prisma rather than the
 * rows that come back. Asserting the rows would only prove the mock returned
 * what the mock was told to return; asserting `omit: { token: true }` proves
 * the manifest actually withholds the credential.
 *
 * @see lib/privacy/export-user.ts
 * @see lib/privacy/export-sources.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so the factories below can close over them
// ---------------------------------------------------------------------------

const { mockPrisma, delegateFor, resetDelegates, mockUserFindUnique, mockLogger } = vi.hoisted(
  () => {
    interface Delegate {
      findMany: ReturnType<typeof vi.fn>;
    }

    // The manifest touches ~28 delegates. Rather than hand-declare each (and
    // silently miss one as the manifest grows), vend them on demand and keep a
    // registry the tests can inspect.
    const delegates = new Map<string, Delegate>();
    const delegateFor = (name: string): Delegate => {
      let delegate = delegates.get(name);
      if (!delegate) {
        delegate = { findMany: vi.fn().mockResolvedValue([]) };
        delegates.set(name, delegate);
      }
      return delegate;
    };

    // `vi.clearAllMocks()` clears recorded calls but NOT implementations, so a
    // `mockResolvedValue` set by one test would otherwise leak into the next —
    // and a leaked row count is the kind of thing that makes a later assertion
    // pass for the wrong reason. Re-arm the default explicitly.
    const resetDelegates = (): void => {
      for (const delegate of delegates.values()) {
        delegate.findMany.mockReset().mockResolvedValue([]);
      }
    };

    const userFindUnique = vi.fn();

    const prisma = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== 'string') return undefined;
          if (property === 'user') return { findUnique: userFindUnique };
          return delegateFor(property);
        },
      }
    );

    return {
      mockPrisma: prisma,
      delegateFor,
      resetDelegates,
      mockUserFindUnique: userFindUnique,
      mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
  }
);

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockCollectAppSubjectData = vi.fn().mockResolvedValue({});
vi.mock('@/lib/app/data-export', () => ({
  collectAppSubjectData: (...args: unknown[]) => mockCollectAppSubjectData(...args),
}));

// ---------------------------------------------------------------------------

import {
  exportUserData,
  SubjectNotFoundError,
  EXPORT_FORMAT_VERSION,
} from '@/lib/privacy/export-user';
import {
  SUBJECT_DATA_SOURCES,
  EXCLUDED_SOURCES,
  type SubjectDataSource,
} from '@/lib/privacy/export-sources';

const SUBJECT = {
  id: 'user-1',
  email: 'Subject@Example.com',
  name: 'Subject',
  role: 'USER',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const PARAMS = { userId: 'user-1', actorUserId: 'user-1', reason: 'self_service' as const };

/** Every findMany call made against one delegate during the test. */
function callsTo(delegate: string): unknown[][] {
  return delegateFor(delegate).findMany.mock.calls;
}

/** The single findMany argument object a delegate was called with. */
function argsTo(delegate: string): Record<string, unknown> {
  const calls = callsTo(delegate);
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDelegates();
  mockUserFindUnique.mockResolvedValue(SUBJECT);
  mockCollectAppSubjectData.mockResolvedValue({});
});

describe('exportUserData', () => {
  describe('subject lookup', () => {
    it('throws SubjectNotFoundError when no account row exists', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData(PARAMS)).rejects.toThrow(SubjectNotFoundError);
    });

    it('names the missing id in the error', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData({ ...PARAMS, userId: 'ghost' })).rejects.toThrow(/ghost/);
    });

    it('runs no source queries when the subject does not exist', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData(PARAMS)).rejects.toThrow(SubjectNotFoundError);
      expect(callsTo('session')).toHaveLength(0);
    });

    it('returns the account row verbatim', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.account).toEqual(SUBJECT);
    });
  });

  describe('credential redaction', () => {
    // These are the cases that would turn an access response into a breach.
    it('withholds the session token', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('session')).toMatchObject({
        where: { userId: 'user-1' },
        omit: { token: true },
      });
    });

    it('withholds the password hash and OAuth tokens', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('account').omit).toEqual({
        password: true,
        accessToken: true,
        refreshToken: true,
        idToken: true,
      });
    });

    it('withholds the API key hash', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiApiKey').omit).toEqual({ keyHash: true });
    });

    it('withholds the webhook signing secret', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiWebhookSubscription').omit).toEqual({ secret: true });
    });

    it('uses omit rather than select on every exported source', async () => {
      // `select` would silently narrow the export as columns are added — the
      // failure mode the manifest exists to prevent. Attribution sources are
      // exempt: narrowing is the whole point there.
      await exportUserData(PARAMS);

      const exportedDelegates = [
        'session',
        'account',
        'aiConversation',
        'aiUserMemory',
        'aiApiKey',
      ];
      for (const delegate of exportedDelegates) {
        expect(argsTo(delegate).select, `${delegate} must not use select`).toBeUndefined();
      }
    });
  });

  describe('scoping', () => {
    it('scopes userId-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiUserMemory').where).toEqual({ userId: 'user-1' });
    });

    it('scopes createdBy-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiAgent').where).toEqual({ createdBy: 'user-1' });
    });

    it('scopes uploadedBy-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiKnowledgeDocument').where).toEqual({ uploadedBy: 'user-1' });
    });

    it('matches conversations on the subject alone, with no inbound filter', async () => {
      // Inbound threads used to be written with `userId = trigger.createdBy`
      // — the operator who configured the channel — while the messages and
      // `fromAddress` belonged to whoever sent them, so this source filtered
      // `channel: null` to avoid handing one subject another person's
      // correspondence. #502 made those rows system-owned (`userId: null`),
      // which excludes them from this query by construction. The filter is
      // gone, and the subject's own chat history is no longer narrowed by a
      // predicate that was never about them.
      await exportUserData(PARAMS);

      expect(argsTo('aiConversation').where).toEqual({ userId: 'user-1' });
    });

    it('matches workflow runs on the subject alone, with no trigger-source filter', async () => {
      // Same retirement as conversations above. An inbound run's `inputData`
      // is the adapter payload verbatim — sender number, email body,
      // attachments — so while those rows carried an operator's id, this
      // source had to filter `triggerSource: null` to stay honest.
      await exportUserData(PARAMS);

      expect(argsTo('aiWorkflowExecution').where).toEqual({ userId: 'user-1' });
    });

    it('matches contact submissions on the subject email, case-insensitively', async () => {
      // No FK to User — the public form takes an address. Case matters because
      // the stored address may differ in case from the account's.
      await exportUserData(PARAMS);

      expect(argsTo('contactSubmission').where).toEqual({
        email: { equals: 'Subject@Example.com', mode: 'insensitive' },
      });
    });
  });

  describe('bundle composition', () => {
    it('files each source under its declared section and disposition', async () => {
      const bundle = await exportUserData(PARAMS);

      for (const source of SUBJECT_DATA_SOURCES) {
        const target = source.disposition === 'export' ? bundle.personalData : bundle.attributions;
        expect(Object.keys(target), `${source.model} → ${source.section}`).toContain(
          source.section
        );
      }
    });

    it('keeps personal data and attribution in separate buckets', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(Object.keys(bundle.personalData)).toContain('sessions');
      expect(Object.keys(bundle.personalData)).not.toContain('agents');
      expect(Object.keys(bundle.attributions)).toContain('agents');
      expect(Object.keys(bundle.attributions)).not.toContain('sessions');
    });

    it('returns attribution rows as id + label + date only', async () => {
      delegateFor('aiAgent').findMany.mockResolvedValue([
        { id: 'agent-1', name: 'Support bot', createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.agents).toEqual([
        { id: 'agent-1', label: 'Support bot', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('labels versioned attribution rows by version number', async () => {
      delegateFor('aiAgentVersion').findMany.mockResolvedValue([
        { id: 'ver-1', version: 3, createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.agentVersions).toEqual([
        { id: 'ver-1', label: 'v3', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('includes erasure receipts naming the subject', async () => {
      const receipt = { id: 'receipt-1', subjectUserId: 'user-1', reason: 'self_service' };
      delegateFor('dataErasureReceipt').findMany.mockResolvedValue([receipt]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.erasureReceipts).toEqual([receipt]);
      expect(argsTo('dataErasureReceipt').where).toEqual({ subjectUserId: 'user-1' });
    });
  });

  describe('the app seam', () => {
    it('passes the subject id and email to the collector', async () => {
      await exportUserData(PARAMS);

      expect(mockCollectAppSubjectData).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'Subject@Example.com',
      });
    });

    it('folds the collector result into the app section', async () => {
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [{ id: 'inv-1' }] });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({ invoices: [{ id: 'inv-1' }] });
    });

    it('yields an empty app section on the vanilla default', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({});
    });

    it('fails the export when the collector throws', async () => {
      // App-side trouble must not produce a bundle that reads as complete.
      mockCollectAppSubjectData.mockRejectedValue(new Error('app db down'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('app db down');
    });
  });

  describe('meta', () => {
    it('reports the format version', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    });

    it('summarises every source with its row count', async () => {
      delegateFor('aiUserMemory').findMany.mockResolvedValue([{ id: 'm-1' }, { id: 'm-2' }]);

      const bundle = await exportUserData(PARAMS);
      const memory = bundle.meta.exported.find((entry) => entry.model === 'AiUserMemory');

      expect(memory).toMatchObject({ section: 'agentMemory', rows: 2 });
      expect(memory?.description.length).toBeGreaterThan(10);
    });

    it('accounts for every manifest source across the two summaries', async () => {
      const bundle = await exportUserData(PARAMS);

      const summarised = [...bundle.meta.exported, ...bundle.meta.attribution].map(
        (entry) => entry.model
      );

      expect(summarised.sort()).toEqual(SUBJECT_DATA_SOURCES.map((s) => s.model).sort());
    });

    it('discloses a narrowed source’s scope to the subject', async () => {
      // A narrowed source that reported only a row count would be the
      // silent-omission failure at row granularity — the count reads like a
      // complete answer either way.
      //
      // No shipped source narrows today (#502 removed the last two, which
      // existed to contain inbound rows mis-attributed to an operator), so the
      // mechanism is exercised through a source pushed on for this test.
      // Without it, the next author to add a filtered `fetch` would find the
      // disclosure path untested.
      const narrowed: SubjectDataSource = {
        model: 'SmokeNarrowed',
        section: 'smokeNarrowed',
        disposition: 'export',
        description: 'Synthetic source used to exercise scope disclosure.',
        scopeNote: 'Covers only the rows this test says it covers, and nothing else.',
        fetch: () => Promise.resolve([]),
      };
      SUBJECT_DATA_SOURCES.push(narrowed);
      try {
        const bundle = await exportUserData(PARAMS);
        const entry = bundle.meta.exported.find((e) => e.model === 'SmokeNarrowed');

        expect(entry?.scopeNote).toBe(narrowed.scopeNote);
      } finally {
        SUBJECT_DATA_SOURCES.pop();
      }
    });

    it('leaves every shipped source unnarrowed', async () => {
      // The inverse pin. `AiConversation` and `AiWorkflowExecution` carried
      // filters and scope notes between #467 and #502, to keep a third party's
      // inbound messages out of an export that matched them on the operator's
      // `userId`. Those rows are system-owned now, so the export is whole
      // again — and if a filter ever comes back it must arrive with a note.
      const bundle = await exportUserData(PARAMS);
      const narrowedModels = bundle.meta.exported
        .filter((entry) => entry.scopeNote !== undefined)
        .map((entry) => entry.model);

      expect(narrowedModels).toEqual([]);
    });

    it('leaves scopeNote absent on sources that return every matching row', async () => {
      const bundle = await exportUserData(PARAMS);
      const memory = bundle.meta.exported.find((entry) => entry.model === 'AiUserMemory');

      expect(memory).not.toHaveProperty('scopeNote');
    });

    it('discloses what was deliberately withheld', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.excluded).toEqual(EXCLUDED_SOURCES);
      expect(bundle.meta.excluded.length).toBeGreaterThan(0);
    });

    it('stamps the subject and generation time', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.subjectUserId).toBe('user-1');
      expect(new Date(bundle.meta.generatedAt).getTime()).not.toBeNaN();
    });
  });

  describe('failing whole rather than partial', () => {
    it('rejects when any single source throws', async () => {
      // The opposite of the erasure path, which swallows hook failures. A
      // silently-missing section is undetectable to the person reading it.
      delegateFor('aiConversation').findMany.mockRejectedValue(new Error('conversations offline'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('conversations offline');
    });

    it('rejects when the receipt lookup throws', async () => {
      delegateFor('dataErasureReceipt').findMany.mockRejectedValue(new Error('receipts offline'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('receipts offline');
    });
  });

  describe('logging', () => {
    it('records the actor, reason and volume', async () => {
      delegateFor('aiUserMemory').findMany.mockResolvedValue([{ id: 'm-1' }]);

      await exportUserData({ userId: 'user-1', actorUserId: 'admin-9', reason: 'admin_action' });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Subject data export generated',
        expect.objectContaining({
          userId: 'user-1',
          actorUserId: 'admin-9',
          reason: 'admin_action',
          totalRows: 1,
        })
      );
    });
  });
});
