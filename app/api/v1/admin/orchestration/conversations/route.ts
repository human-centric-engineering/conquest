/**
 * Admin Orchestration — Conversations list
 *
 * GET /api/v1/admin/orchestration/conversations
 *
 * Returns the calling admin's own conversations, plus actively-shared ones
 * and system-owned inbound threads (`userId IS NULL`). Matches the scoping
 * used by the detail, PATCH, and DELETE endpoints. Supports filtering by
 * agent, date range, and text search. Any `userId` query parameter is
 * ignored — callers never see another admin's own conversations.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { listConversationsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, agentId, isActive, q, messageSearch, tag, dateFrom, dateTo } =
    validateQueryParams(searchParams, listConversationsQuerySchema);
  const skip = (page - 1) * limit;

  // Caller can see conversations they own, conversations the owner has
  // actively shared with admins, and system-owned inbound threads
  // (`userId IS NULL` — nobody's personal data, the deployment's record of
  // an SMS / WhatsApp / email exchange). The three arms mirror the three
  // bases in `adminCanViewConversation`; the "active share" predicate
  // repeats `isShareActive` inline because Prisma's where-clause query
  // builder doesn't accept a function predicate.
  const visibilityClause: Prisma.AiConversationWhereInput = {
    OR: [
      { userId: session.user.id },
      { userId: null },
      {
        share: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
    ],
  };

  const filterClauses: Prisma.AiConversationWhereInput[] = [];
  if (agentId) filterClauses.push({ agentId });
  if (isActive !== undefined) filterClauses.push({ isActive });
  if (q) filterClauses.push({ title: { contains: q, mode: 'insensitive' } });
  if (messageSearch) {
    filterClauses.push({
      messages: { some: { content: { contains: messageSearch, mode: 'insensitive' } } },
    });
  }
  if (tag) filterClauses.push({ tags: { has: tag } });
  if (dateFrom || dateTo) {
    filterClauses.push({
      updatedAt: {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo) } : {}),
      },
    });
  }

  const where: Prisma.AiConversationWhereInput =
    filterClauses.length > 0 ? { AND: [visibilityClause, ...filterClauses] } : visibilityClause;

  const [conversations, total] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.aiConversation.count({ where }),
  ]);

  log.info('Conversations listed', { count: conversations.length, total });

  return paginatedResponse(conversations, { page, limit, total });
});
