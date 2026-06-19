/**
 * loadSessionSurfaceConfig — authenticated respondent surface bootstrap (F7.1).
 *
 * Reads the ownership fields (status, respondentUserId) and the nested version
 * config from `prisma.appQuestionnaireSession.findUnique`, then flattens the
 * result to `{ status, respondentUserId, config }`. Returns `null` when the row
 * doesn't exist.
 *
 * Assertions pin:
 *   - the exact `where` and `select` shape passed to Prisma (not just that it
 *     was called — the caller depends on the precise select for correctness)
 *   - flattening: `row.version.config` is lifted to the top-level `config` key
 *   - null passthrough: missing session → null, not a thrown error
 *   - null config: version row with a null config is preserved as `config: null`
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/session-surface-config.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Prisma mock — hoist so it is available before the import below ───────────
// Pattern mirrors transcript.test.ts in this directory.
const findUnique = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

// ─── Imports (after mock declarations) ───────────────────────────────────────
import {
  loadSessionSurfaceConfig,
  type SessionSurfaceConfig,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-surface-config';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A well-formed DB row returned by `findUnique` when the session exists. */
function makeDbRow(
  over: Partial<{
    status: string;
    respondentUserId: string | null;
    config: SessionSurfaceConfig['config'];
  }> = {}
) {
  return {
    status: over.status ?? 'active',
    respondentUserId: over.respondentUserId !== undefined ? over.respondentUserId : 'user-1',
    version: {
      config:
        over.config !== undefined
          ? over.config
          : {
              anonymousMode: false,
              presentationMode: 'chat',
              voiceEnabled: false,
              attachmentsEnabled: false,
              reasoningStreamEnabled: true,
              reasoningStreamPlacement: 'inline',
            },
    },
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('loadSessionSurfaceConfig', () => {
  describe('Prisma query shape', () => {
    it('calls findUnique with the correct where clause for the given sessionId', async () => {
      findUnique.mockResolvedValue(makeDbRow());
      await loadSessionSurfaceConfig('sess-abc');

      // Anti-green-bar: assert what the function DID, not what it returned
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-abc' },
        })
      );
    });

    it('selects status, respondentUserId, and the nested version config fields', async () => {
      findUnique.mockResolvedValue(makeDbRow());
      await loadSessionSurfaceConfig('sess-abc');

      // The select must ask for the exact fields the caller relies on — omitting
      // any would silently drop data from the returned shape
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            status: true,
            respondentUserId: true,
            version: {
              select: {
                config: {
                  select: {
                    anonymousMode: true,
                    presentationMode: true,
                    voiceEnabled: true,
                    attachmentsEnabled: true,
                    reasoningStreamEnabled: true,
                    reasoningStreamPlacement: true,
                    reasoningStreamDwellMs: true,
                    reasoningStreamPerItemMs: true,
                  },
                },
              },
            },
          },
        })
      );
    });
  });

  describe('result flattening when a row exists', () => {
    it('lifts version.config to the top-level config key', async () => {
      const dbRow = makeDbRow({
        status: 'active',
        respondentUserId: 'user-42',
        config: {
          anonymousMode: true,
          presentationMode: 'form',
          voiceEnabled: true,
          attachmentsEnabled: false,
          reasoningStreamEnabled: false,
          reasoningStreamPlacement: 'sidebar',
          reasoningStreamDwellMs: 2000,
          reasoningStreamPerItemMs: 330,
        },
      });
      findUnique.mockResolvedValue(dbRow);

      const result = await loadSessionSurfaceConfig('sess-xyz');

      // The function must flatten row.version.config → result.config (not row.version.config)
      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('version');
      expect(result!.config).toEqual({
        anonymousMode: true,
        presentationMode: 'form',
        voiceEnabled: true,
        attachmentsEnabled: false,
        reasoningStreamEnabled: false,
        reasoningStreamPlacement: 'sidebar',
        reasoningStreamDwellMs: 2000,
        reasoningStreamPerItemMs: 330,
      });
    });

    it('maps status from the DB row to the top-level status field', async () => {
      findUnique.mockResolvedValue(makeDbRow({ status: 'completed' }));

      const result = await loadSessionSurfaceConfig('sess-1');

      // Anti-green-bar: assert the TRANSFORMATION — the function copies status from
      // the nested DB row to the flat result, not the same reference
      expect(result!.status).toBe('completed');
    });

    it('maps respondentUserId from the DB row to the top-level field', async () => {
      findUnique.mockResolvedValue(makeDbRow({ respondentUserId: 'user-99' }));

      const result = await loadSessionSurfaceConfig('sess-1');

      expect(result!.respondentUserId).toBe('user-99');
    });

    it('preserves null respondentUserId for anonymous sessions', async () => {
      findUnique.mockResolvedValue(makeDbRow({ respondentUserId: null }));

      const result = await loadSessionSurfaceConfig('sess-anon');

      // Anonymous sessions have no respondentUserId — the function must not coerce it
      expect(result!.respondentUserId).toBeNull();
    });

    it('preserves null version config when the version has no config record', async () => {
      // A version may have no config row yet (e.g. just created) — the function must
      // return config: null rather than throwing or substituting defaults
      findUnique.mockResolvedValue(makeDbRow({ config: null }));

      const result = await loadSessionSurfaceConfig('sess-no-cfg');

      expect(result!.config).toBeNull();
    });

    it('returns all eight config fields with their exact DB values', async () => {
      const expectedConfig: SessionSurfaceConfig['config'] = {
        anonymousMode: false,
        presentationMode: 'chat',
        voiceEnabled: true,
        attachmentsEnabled: true,
        reasoningStreamEnabled: true,
        reasoningStreamPlacement: 'inline',
        reasoningStreamDwellMs: 1500,
        reasoningStreamPerItemMs: 250,
      };
      findUnique.mockResolvedValue(makeDbRow({ config: expectedConfig }));

      const result = await loadSessionSurfaceConfig('sess-full');

      // All eight config fields must be present and match the DB values — none omitted
      expect(result!.config).toEqual(expectedConfig);
    });
  });

  describe('null passthrough when the session does not exist', () => {
    it('returns null when findUnique resolves null', async () => {
      findUnique.mockResolvedValue(null);

      const result = await loadSessionSurfaceConfig('sess-missing');

      // The page maps null → 404; the function must not throw or return a partial shape
      expect(result).toBeNull();
    });

    it('does not call any other DB methods when the row is absent', async () => {
      findUnique.mockResolvedValue(null);

      await loadSessionSurfaceConfig('sess-missing');

      // Only one DB call should occur — no follow-up reads
      expect(findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
