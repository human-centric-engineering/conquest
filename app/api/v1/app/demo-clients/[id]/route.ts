/**
 * DEMO-ONLY (F2.5.1): single demo-client endpoint.
 *
 * GET    /api/v1/app/demo-clients/:id   — detail (404 when unknown).
 * PATCH  /api/v1/app/demo-clients/:id   — edit any identity field (audited; slug collision → 409).
 * DELETE /api/v1/app/demo-clients/:id   — delete, REFUSED with 409 while any
 *        questionnaire is still attributed (the admin must detach/reassign first).
 *
 * All: flag-gate first (404 when off), then `withAdminAuth`, then 404 on unknown id.
 * A real client engagement strips this surface — see forking.md § "Replacing demo tenancy".
 */

import { Prisma } from '@prisma/client';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateDemoClientSchema } from '@/lib/app/questionnaire/demo-clients';
import {
  DEMO_CLIENT_SELECT,
  getDemoClientDetail,
  toDemoClientView,
} from '@/app/api/v1/app/demo-clients/_lib/read';

const handleDetail = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const client = await getDemoClientDetail(id);
  if (!client) {
    throw new NotFoundError('Demo client not found');
  }

  log.info('Demo client detail read', { id });
  return successResponse(client);
});

const handleUpdate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appDemoClient.findUnique({
    where: { id },
    select: DEMO_CLIENT_SELECT,
  });
  if (!before) {
    throw new NotFoundError('Demo client not found');
  }

  const body = await validateRequestBody(request, updateDemoClientSchema);

  try {
    const updated = await prisma.appDemoClient.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        // DEMO-ONLY (F3.4): theme columns — present (incl. null to clear) patches the column.
        ...(body.ctaColor !== undefined ? { ctaColor: body.ctaColor } : {}),
        ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
        ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
        ...(body.welcomeCopy !== undefined ? { welcomeCopy: body.welcomeCopy } : {}),
        // DEMO-ONLY (F7.1+): respondent-session chrome columns.
        ...(body.surfaceColor !== undefined ? { surfaceColor: body.surfaceColor } : {}),
        ...(body.ctaColorEnd !== undefined ? { ctaColorEnd: body.ctaColorEnd } : {}),
        ...(body.logoBackgroundColor !== undefined
          ? { logoBackgroundColor: body.logoBackgroundColor }
          : {}),
        ...(body.logoBackgroundEnabled !== undefined
          ? { logoBackgroundEnabled: body.logoBackgroundEnabled }
          : {}),
      },
      select: DEMO_CLIENT_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_demo_client.update',
      entityType: 'app_demo_client',
      entityId: id,
      entityName: updated.name,
      changes: computeChanges(before, updated),
      clientIp,
    });
    log.info('Demo client updated', { id });

    return successResponse(toDemoClientView(updated));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A demo client with this slug already exists', {
        code: 'SLUG_CONFLICT',
        status: 409,
        details: { slug: [`"${body.slug}" is already taken`] },
      });
    }
    throw err;
  }
});

const handleDelete = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const client = await prisma.appDemoClient.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, _count: { select: { questionnaires: true } } },
  });
  if (!client) {
    throw new NotFoundError('Demo client not found');
  }

  // 409-guard (F2.5.1 AD2): refuse while questionnaires are still attributed. The
  // FK is SetNull, so a delete would silently detach them — refuse instead and tell
  // the admin to reassign/detach first. The count is the read model's, kept fresh.
  if (client._count.questionnaires > 0) {
    return errorResponse('Detach or reassign this client’s questionnaires before deleting it', {
      code: 'DEMO_CLIENT_IN_USE',
      status: 409,
      details: { questionnaireCount: client._count.questionnaires },
    });
  }

  await prisma.appDemoClient.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_demo_client.delete',
    entityType: 'app_demo_client',
    entityId: id,
    entityName: client.name,
    metadata: { slug: client.slug },
    clientIp,
  });
  log.info('Demo client deleted', { id });

  return successResponse({ id, deleted: true });
});

export const GET = handleDetail;
export const PATCH = handleUpdate;
export const DELETE = handleDelete;
