/**
 * Tests for `lib/orchestration/access/conversation-access.ts`.
 *
 * The helper is the single point at which "can this admin view this
 * conversation?" is decided. Getting it wrong has direct privacy
 * implications, so we test every combination of (owner / non-owner) ×
 * (no share / active share / expired share / revoked share) plus the
 * missing-conversation path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findUnique: vi.fn(),
    },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { adminCanViewConversation, isShareActive } =
  await import('@/lib/orchestration/access/conversation-access');

const findUnique = prisma.aiConversation.findUnique as ReturnType<typeof vi.fn>;

const ADMIN_ID = 'admin-1';
const OWNER_ID = 'user-1';
const CONV_ID = 'conv-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adminCanViewConversation', () => {
  it('returns ok=true with basis=owner when caller owns the conversation', async () => {
    findUnique.mockResolvedValue({ userId: ADMIN_ID, share: null });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result).toEqual({ ok: true, basis: 'owner', ownerId: ADMIN_ID });
  });

  it('returns ok=true with basis=system when nobody owns the conversation', async () => {
    // Inbound threads (SMS / WhatsApp / email / Slack) carry `userId: null`
    // since #502 — the messages are a third party's, not any account
    // holder's. Without this basis an admin could not read, rename or
    // delete one, including on the sender's own erasure request.
    findUnique.mockResolvedValue({ userId: null, share: null });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result).toEqual({ ok: true, basis: 'system', ownerId: null });
  });

  it('reports basis=system, never owner, for an unowned conversation', async () => {
    // Guards the ordering inside the helper: were the owner comparison to
    // run first, a caller whose id was somehow nullish would be reported as
    // the owner of every unowned row, and the access would skip its audit
    // row (owner accesses are deliberately not logged).
    findUnique.mockResolvedValue({ userId: null, share: null });

    const result = await adminCanViewConversation(CONV_ID, '');

    expect(result.basis).toBe('system');
    expect(result.ownerId).toBeNull();
  });

  it('returns ok=true with basis=shared when an active share exists', async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: futureExpiry },
    });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result).toEqual({ ok: true, basis: 'shared', ownerId: OWNER_ID });
  });

  it('returns ok=true with basis=shared for a never-expiring active share', async () => {
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: null }, // no expiry
    });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result.ok).toBe(true);
    expect(result.basis).toBe('shared');
  });

  it('denies (basis=null, ownerId=null) when no share exists and caller is not owner', async () => {
    // Returning null for ownerId on deny avoids leaking owner identity
    // on a 404 — preventing a user-enumeration vector.
    findUnique.mockResolvedValue({ userId: OWNER_ID, share: null });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result).toEqual({ ok: false, basis: null, ownerId: null });
  });

  it('denies when the share has been revoked', async () => {
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: new Date(), expiresAt: null },
    });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result.ok).toBe(false);
    expect(result.basis).toBeNull();
  });

  it('denies when the share has expired', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000);
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: pastExpiry },
    });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result.ok).toBe(false);
    expect(result.basis).toBeNull();
  });

  it('denies (and treats as missing) when the conversation does not exist', async () => {
    findUnique.mockResolvedValue(null);

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result).toEqual({ ok: false, basis: null, ownerId: null });
  });

  it('passes the conversation id through to findUnique unchanged', async () => {
    findUnique.mockResolvedValue({ userId: ADMIN_ID, share: null });

    await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CONV_ID } }));
  });

  it('owner check takes precedence over a share record (defense in depth)', async () => {
    // If the caller is the owner AND a share happens to exist (e.g.
    // they shared their own conversation with their own admin
    // account), basis should report 'owner' — not 'shared' — so the
    // audit log doesn't spuriously record their own access as a
    // cross-user event.
    findUnique.mockResolvedValue({
      userId: ADMIN_ID,
      share: { revokedAt: null, expiresAt: null },
    });

    const result = await adminCanViewConversation(CONV_ID, ADMIN_ID);

    expect(result.basis).toBe('owner');
  });
});

describe('isShareActive', () => {
  it('returns true for a fresh share with no expiry', () => {
    expect(isShareActive({ revokedAt: null, expiresAt: null })).toBe(true);
  });

  it('returns true for a share with a future expiry', () => {
    const future = new Date(Date.now() + 60_000);
    expect(isShareActive({ revokedAt: null, expiresAt: future })).toBe(true);
  });

  it('returns false for a revoked share', () => {
    expect(isShareActive({ revokedAt: new Date(), expiresAt: null })).toBe(false);
  });

  it('returns false for an expired share', () => {
    const past = new Date(Date.now() - 60_000);
    expect(isShareActive({ revokedAt: null, expiresAt: past })).toBe(false);
  });

  it('returns false when both revoked and expired (revoke wins or expiry wins; result is the same)', () => {
    expect(isShareActive({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 60_000) })).toBe(
      false
    );
  });
});
