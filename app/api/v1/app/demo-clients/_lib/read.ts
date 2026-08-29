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
import { APP_QUESTIONNAIRE_STATUSES, narrowToEnum } from '@/lib/app/questionnaire/types';
import { DEMO_CLIENT_THEME_SELECT } from '@/lib/app/questionnaire/theming';

/**
 * Selection shared by every demo-client read/write serializer — identity columns
 * plus the attributed count. Exported so the create/update routes project through
 * the same shape as list/detail (one source of truth, no drift).
 */
export const DEMO_CLIENT_SELECT = {
  // `id` is not listed here: the theme fragment below already selects it, because the resolver
  // needs it to address the client's self-hosted font files. Listing it twice is a TS error.
  slug: true,
  name: true,
  description: true,
  isActive: true,
  // DEMO-ONLY: every theme column, from the one fragment the whole product selects with
  // (see lib/app/questionnaire/theming/select.ts). The admin form prefills from these and
  // the invitation / respondent seams resolve them. Nullable; null = ConQuest default.
  ...DEMO_CLIENT_THEME_SELECT,
  createdAt: true,
  updatedAt: true,
  _count: { select: { questionnaires: true } },
} as const;

type DemoClientRow = Prisma.AppDemoClientGetPayload<{ select: typeof DEMO_CLIENT_SELECT }>;

/**
 * Detail read adds the attributed-questionnaire list to the shared selection — the rows
 * the detail page links to so the delete guard's "detach or reassign first" has a
 * destination. Newest-first; identity-only columns (no per-version fan-out).
 */
const DEMO_CLIENT_DETAIL_SELECT = {
  ...DEMO_CLIENT_SELECT,
  questionnaires: {
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, status: true },
  },
} as const satisfies Prisma.AppDemoClientSelect;

type DemoClientDetailRow = Prisma.AppDemoClientGetPayload<{
  select: typeof DEMO_CLIENT_DETAIL_SELECT;
}>;

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
    bannerUrl: row.bannerUrl,
    welcomeCopy: row.welcomeCopy,
    surfaceColor: row.surfaceColor,
    ctaColorEnd: row.ctaColorEnd,
    logoBackgroundColor: row.logoBackgroundColor,
    logoBackgroundEnabled: row.logoBackgroundEnabled,
    canvasColor: row.canvasColor,
    inkColor: row.inkColor,
    canvasColorDark: row.canvasColorDark,
    inkColorDark: row.inkColorDark,
    accentColorEnd: row.accentColorEnd,
    logoMarkUrl: row.logoMarkUrl,
    logoDarkUrl: row.logoDarkUrl,
    fontPairing: row.fontPairing,
    customFontDisplay: row.customFontDisplay,
    customFontBody: row.customFontBody,
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

/** Project a detail row to the view, attaching the attributed-questionnaire list. */
function toDemoClientDetail(row: DemoClientDetailRow): DemoClientDetail {
  return {
    ...toDemoClientView(row),
    questionnaires: row.questionnaires.map((q) => ({
      id: q.id,
      title: q.title,
      status: narrowToEnum(q.status, APP_QUESTIONNAIRE_STATUSES, 'draft'),
    })),
  };
}

/** One demo client by id (with its attributed questionnaires), or `null` when absent (route maps null → 404). */
export async function getDemoClientDetail(id: string): Promise<DemoClientDetail | null> {
  const row = await prisma.appDemoClient.findUnique({
    where: { id },
    select: DEMO_CLIENT_DETAIL_SELECT,
  });
  return row ? toDemoClientDetail(row) : null;
}
