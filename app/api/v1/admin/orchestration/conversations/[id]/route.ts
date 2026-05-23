/**
 * Admin Orchestration — Single conversation (GET, PATCH, DELETE)
 *
 * GET    /api/v1/admin/orchestration/conversations/:id   — consent-gated read
 * PATCH  /api/v1/admin/orchestration/conversations/:id   — owner-only mutation
 * DELETE /api/v1/admin/orchestration/conversations/:id   — owner-only destroy
 *
 * Read access goes through `adminCanViewConversation`: the caller can
 * GET either their own conversation OR one the owner has actively
 * shared (see `AiConversationShare`). Cross-user reads on a shared
 * conversation write an audit row.
 *
 * **Mutations stay owner-only by design.** A share grants *view*
 * consent, not write-or-destroy consent. Allowing a non-owner admin to
 * PATCH (rename/archive) or DELETE a shared conversation would let the
 * sharee unilaterally modify the sharer's data — outside the
 * consent contract. The owner-only check is preserved on PATCH/DELETE.
 *
 * `AiMessage` rows cascade via the foreign key relation on DELETE.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateConversationSchema } from '@/lib/validations/orchestration';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const access = await adminCanViewConversation(id, session.user.id);
  if (!access.ok) throw new NotFoundError(`Conversation ${id} not found`);

  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  log.info('Conversation fetched', { conversationId: id, accessBasis: access.basis });

  logConversationAccess({
    adminUserId: session.user.id,
    conversationId: id,
    conversationTitle: conversation.title,
    conversationOwnerId: conversation.userId,
    accessBasis: access.basis ?? 'owner',
    action: 'conversation.metadata_viewed',
    clientIp: getClientIP(request),
  });

  return successResponse(conversation);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body: unknown = await request.json();
  const data = updateConversationSchema.parse(body);

  const existing = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) throw new NotFoundError(`Conversation ${id} not found`);

  const updated = await prisma.aiConversation.update({
    where: { id },
    data,
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } },
    },
  });

  log.info('Conversation updated', { conversationId: id, fields: Object.keys(data) });
  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Ownership enforcement: 404 (not 403) if missing OR owned by another user.
  const existing = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) throw new NotFoundError(`Conversation ${id} not found`);

  await prisma.aiConversation.delete({ where: { id } });

  log.info('Conversation deleted', { conversationId: id, userId: session.user.id });
  return successResponse({ deleted: true });
});
