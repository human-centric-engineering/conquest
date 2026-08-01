/**
 * Integration Test: Admin Orchestration — Update Conversation (PATCH)
 *
 * PATCH /api/v1/admin/orchestration/conversations/:id
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/route.ts
 *
 * Key assertions:
 * - Admin auth required
 * - Updates title and tags
 * - Validates tag limits
 * - 404 for other user's conversations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/v1/admin/orchestration/conversations/[id]/route';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      // `findUnique` backs `adminCanViewConversation`, which replaced the
      // inline ownership `findFirst` (#502).
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // Backs `logConversationAccess` — a non-owner PATCH leaves an audit row.
    aiAdminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    userId: ADMIN_ID,
    share: null,
    agentId: AGENT_ID,
    title: 'Test Conversation',
    tags: [],
    isActive: true,
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
    _count: { messages: 5 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(id: string, body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/conversations/${id}`,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/conversations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makeRequest(CONV_ID, { tags: ['bug'] }), makeParams(CONV_ID));

    expect(response.status).toBe(401);
  });

  it('updates tags on a conversation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as any);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue(
      makeConversation({ tags: ['escalate', 'bug-report'] }) as any
    );

    const response = await PATCH(
      makeRequest(CONV_ID, { tags: ['escalate', 'bug-report'] }),
      makeParams(CONV_ID)
    );

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { tags: string[] } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.tags).toEqual(['escalate', 'bug-report']);
  });

  it('updates title on a conversation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as any);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue(
      makeConversation({ title: 'Updated title' }) as any
    );

    const response = await PATCH(
      makeRequest(CONV_ID, { title: 'Updated title' }),
      makeParams(CONV_ID)
    );

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { title: string } }>(response);
    expect(body.data.title).toBe('Updated title');
  });

  it('returns 404 for non-existent conversation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

    const response = await PATCH(makeRequest(CONV_ID, { tags: ['test'] }), makeParams(CONV_ID));

    expect(response.status).toBe(404);
  });

  it('returns 400 for invalid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(
      makeRequest('not-a-cuid', { tags: ['test'] }),
      makeParams('not-a-cuid')
    );

    expect(response.status).toBe(400);
  });

  describe('audit logging', () => {
    it('records a PATCH of a system-owned inbound thread', async () => {
      // Renaming or archiving an inbound thread edits a third party's record.
      // They have no account here and cannot check the log themselves, so the
      // mutation leaves the same trail a delete does.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: null }) as any
      );
      vi.mocked(prisma.aiConversation.update).mockResolvedValue(
        makeConversation({ userId: null, title: 'Renamed' }) as any
      );

      const response = await PATCH(makeRequest(CONV_ID, { title: 'Renamed' }), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.aiAdminAuditLog.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: ADMIN_ID,
            action: 'conversation.updated',
            entityType: 'conversation',
            entityId: CONV_ID,
            metadata: expect.objectContaining({
              accessBasis: 'system',
              conversationOwnerId: null,
              // Names what changed without copying the value — a `title` would
              // otherwise put message content into the audit log.
              fields: ['title'],
            }),
          }),
        })
      );
    });

    it('does not log a PATCH of the caller own conversation', async () => {
      // Self-access is deliberately unlogged — routine edits would flood the
      // audit log without adding signal.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as any);
      vi.mocked(prisma.aiConversation.update).mockResolvedValue(
        makeConversation({ title: 'Renamed' }) as any
      );

      await PATCH(makeRequest(CONV_ID, { title: 'Renamed' }), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiAdminAuditLog.create)).not.toHaveBeenCalled();
    });

    it('refuses a PATCH on a merely-shared conversation', async () => {
      // A share grants view consent, not write consent — so there is nothing
      // to audit, because the mutation never happens.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({
          userId: 'someone-else',
          share: { revokedAt: null, expiresAt: null },
        }) as any
      );

      const response = await PATCH(makeRequest(CONV_ID, { title: 'Renamed' }), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.aiConversation.update)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.aiAdminAuditLog.create)).not.toHaveBeenCalled();
    });
  });
});
