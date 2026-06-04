/**
 * DEMO-ONLY (F2.5.1): demo-client read models.
 *
 * The list + detail serializers behind the demo-client GET endpoints. Route-local
 * DB seam — the `lib/app/questionnaire/**` module is Prisma-free, so the read query
 * lives here. Each row carries `questionnaireCount` (the attributed-questionnaire
 * count) from a single `_count` include — no per-row N+1, and the count is what the
 * DELETE 409-guard reads.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import type { DemoClientDetail, DemoClientView } from '@/lib/app/questionnaire/demo-clients';

/**
 * Selection shared by every demo-client read/write serializer — identity columns
 * plus the attributed count. Exported so the create/update routes project through
 * the same shape as list/detail (one source of truth, no drift).
 */
export const DEMO_CLIENT_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  isActive: true,
  // DEMO-ONLY (F3.4): theme columns — the edit form prefills from these and the
  // invitation send seam resolves them. Nullable; null = Sunrise default.
  ctaColor: true,
  accentColor: true,
  logoUrl: true,
  welcomeCopy: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { questionnaires: true } },
} as const;

type DemoClientRow = Prisma.AppDemoClientGetPayload<{ select: typeof DEMO_CLIENT_SELECT }>;

/** Project a `DEMO_CLIENT_SELECT` row to the client-safe view (ISO dates, flattened count). */
export function toDemoClientView(row: DemoClientRow): DemoClientView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    ctaColor: row.ctaColor,
    accentColor: row.accentColor,
    logoUrl: row.logoUrl,
    welcomeCopy: row.welcomeCopy,
    questionnaireCount: row._count.questionnaires,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All demo clients (active and inactive), newest-first. Demo clients are a small set — no pagination. */
export async function listDemoClients(): Promise<DemoClientView[]> {
  const rows = await prisma.appDemoClient.findMany({
    orderBy: { createdAt: 'desc' },
    select: DEMO_CLIENT_SELECT,
  });
  return rows.map(toDemoClientView);
}

/** One demo client by id, or `null` when absent (the route maps null → 404). */
export async function getDemoClientDetail(id: string): Promise<DemoClientDetail | null> {
  const row = await prisma.appDemoClient.findUnique({
    where: { id },
    select: DEMO_CLIENT_SELECT,
  });
  return row ? toDemoClientView(row) : null;
}
