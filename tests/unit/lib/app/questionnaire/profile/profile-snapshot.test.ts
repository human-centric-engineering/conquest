/**
 * Unit test: respondent profile snapshot upsert (F-capture).
 *
 * The upsert MERGES new values into any already stored (new keys win) rather than overwriting, because
 * a hybrid questionnaire builds the snapshot in two passes — the form gate writes its subset, then the
 * conversational extraction adds the in-chat subset. These tests pin that merge so a later pass can
 * never clobber an earlier one. Prisma is mocked; no real I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { upsertProfileSnapshot } from '@/lib/app/questionnaire/profile/profile-snapshot';

/** The (partial) Prisma delegate `upsertProfileSnapshot` accepts — a tx client or the client. */
type SnapshotDb = Parameters<typeof upsertProfileSnapshot>[0];

function dbMock(existingValues: Record<string, unknown> | null) {
  const snapshot = {
    findUnique: vi.fn().mockResolvedValue(existingValues ? { values: existingValues } : null),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
  // Only the two delegate methods the function touches are mocked; cast to the full delegate type.
  const db = { appRespondentProfileSnapshot: snapshot } as unknown as SnapshotDb;
  return { db, snapshot };
}

beforeEach(() => vi.clearAllMocks());

describe('upsertProfileSnapshot', () => {
  it('creates a fresh snapshot when none exists (merge over an empty base)', async () => {
    const { db, snapshot } = dbMock(null);
    await upsertProfileSnapshot(db, 'sess-1', 'user-1', { name: 'Ada' });

    expect(snapshot.upsert).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1' },
      create: { sessionId: 'sess-1', respondentUserId: 'user-1', values: { name: 'Ada' } },
      update: { values: { name: 'Ada' }, respondentUserId: 'user-1' },
    });
  });

  it('MERGES into existing values so a later pass keeps the earlier ones (hybrid: form then chat)', async () => {
    // The form gate wrote name + email; now the conversational extraction adds org + role.
    const { db, snapshot } = dbMock({ name: 'Ada', email: 'ada@example.com' });
    await upsertProfileSnapshot(db, 'sess-1', 'user-1', { org: 'Acme', role: 'CTO' });

    const merged = { name: 'Ada', email: 'ada@example.com', org: 'Acme', role: 'CTO' };
    expect(snapshot.upsert).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1' },
      create: { sessionId: 'sess-1', respondentUserId: 'user-1', values: merged },
      update: { values: merged, respondentUserId: 'user-1' },
    });
  });

  it('lets a new value win when a key is written twice (correction)', async () => {
    const { db, snapshot } = dbMock({ name: 'ada' });
    await upsertProfileSnapshot(db, 'sess-1', null, { name: 'Ada Lovelace' });

    expect(snapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { values: { name: 'Ada Lovelace' }, respondentUserId: null },
      })
    );
  });
});
