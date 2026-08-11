/**
 * DEMO-ONLY (F7.1): resolve the respondent chat surface's brand theme.
 *
 * Walks a session (or version) to its questionnaire's attributed demo client and resolves the
 * four nullable theme columns into a fully-populated {@link ResolvedTheme} (ConQuest defaults
 * fill any gap). The pure projection into CSS custom properties lives in the theming module;
 * this is just the Prisma seam. A fork that strips demo tenancy drops this file and passes
 * `resolveTheme(null)` everywhere.
 *
 * Server-only.
 */

import { prisma } from '@/lib/db/client';
import { loadVersionSurface } from '@/lib/app/questionnaire/chat/surface-config';
import { resolveTheme, type ResolvedTheme } from '@/lib/app/questionnaire/theming';

async function loadClientTheme(demoClientId: string | null): Promise<ResolvedTheme> {
  if (!demoClientId) return resolveTheme(null);
  const client = await prisma.appDemoClient.findUnique({
    where: { id: demoClientId },
    select: {
      ctaColor: true,
      accentColor: true,
      logoUrl: true,
      // The banner is respondent-surface only — the emails and export PDFs deliberately
      // keep rendering the logo, where a 4:1 full-bleed image has no place.
      bannerUrl: true,
      welcomeCopy: true,
      surfaceColor: true,
      ctaColorEnd: true,
      logoBackgroundColor: true,
      logoBackgroundEnabled: true,
    },
  });
  return resolveTheme(client);
}

/**
 * Resolve the theme for a launched version (no-login anonymous surface).
 *
 * The version→client hop rides the shared `cache()`d surface row, so on a respondent page this
 * costs only the client lookup itself — and nothing at all when the questionnaire is unattributed.
 */
export async function resolveThemeForVersion(versionId: string): Promise<ResolvedTheme> {
  const version = await loadVersionSurface(versionId);
  return loadClientTheme(version?.questionnaire.demoClientId ?? null);
}

/** Resolve the theme for an existing session (authenticated surface). */
export async function resolveThemeForSession(sessionId: string): Promise<ResolvedTheme> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { version: { select: { questionnaire: { select: { demoClientId: true } } } } },
  });
  return loadClientTheme(session?.version.questionnaire.demoClientId ?? null);
}
