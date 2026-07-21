/**
 * DEMO-ONLY (F2.5.1): demo-client collection endpoint.
 *
 * GET  /api/v1/app/demo-clients
 *   Admin-only list of every demo client (active and inactive), newest-first, each
 *   with its attributed-questionnaire count. Read model: `_lib/read.ts`.
 *
 * POST /api/v1/app/demo-clients
 *   Create a demo client. Slug is derive-with-override: supplied → validated
 *   kebab-case; absent → derived from the name. A slug collision surfaces as 409.
 *
 * Both: `withAdminAuth`. Mutations are audited.
 * A real client engagement strips this surface — see
 * .context/app/questionnaire/forking.md § "Replacing demo tenancy".
 */

import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createDemoClientSchema, slugifyDemoClient } from '@/lib/app/questionnaire/demo-clients';
import {
  DEMO_CLIENT_SELECT,
  listDemoClients,
  toDemoClientView,
} from '@/app/api/v1/app/demo-clients/_lib/read';

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const clients = await listDemoClients();
  log.info('Demo clients listed', { count: clients.length });
  return successResponse(clients);
});

const handleCreate = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const body = await validateRequestBody(request, createDemoClientSchema);
  const slug = body.slug ?? slugifyDemoClient(body.name);

  try {
    const created = await prisma.appDemoClient.create({
      data: {
        slug,
        name: body.name,
        description: body.description ?? null,
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        // DEMO-ONLY (F3.4): theme columns — absent leaves the column null (Sunrise default).
        ...(body.ctaColor !== undefined ? { ctaColor: body.ctaColor } : {}),
        ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
        ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
        ...(body.bannerUrl !== undefined ? { bannerUrl: body.bannerUrl } : {}),
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
      action: 'app_demo_client.create',
      entityType: 'app_demo_client',
      entityId: created.id,
      entityName: created.name,
      metadata: { slug: created.slug },
      clientIp,
    });
    log.info('Demo client created', { id: created.id, slug: created.slug });

    return successResponse(toDemoClientView(created), undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A demo client with this slug already exists', {
        code: 'SLUG_CONFLICT',
        status: 409,
        details: { slug: [`"${slug}" is already taken`] },
      });
    }
    throw err;
  }
});

export const GET = handleList;
export const POST = handleCreate;
