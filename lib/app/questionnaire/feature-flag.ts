import { errorResponse } from '@/lib/api/responses';
import { isFeatureEnabled } from '@/lib/feature-flags';

/**
 * Feature-flag name gating every questionnaire surface.
 *
 * Seeded (disabled) by `prisma/seeds/app-questionnaire/001-questionnaires-flag.ts`.
 * DB-backed, so it can be toggled at runtime without a redeploy.
 */
export const APP_QUESTIONNAIRES_FLAG = 'APP_QUESTIONNAIRES_ENABLED';

/**
 * Whether the questionnaire app is enabled. Thin wrapper over Sunrise's
 * {@link isFeatureEnabled}.
 *
 * Server-only: it resolves the flag from the database. It imports no specifier
 * banned by the `lib/app/**` boundary, so it's safe to live here, but only call
 * it from a server context (route handler, server component, seed).
 */
export async function isQuestionnairesEnabled(): Promise<boolean> {
  return isFeatureEnabled(APP_QUESTIONNAIRES_FLAG);
}

/**
 * Flag gate for `/api/v1/app/**` route handlers. Returns a `404` {@link Response}
 * when the questionnaire app is disabled — so a switched-off app is
 * indistinguishable from a route that doesn't exist — or `null` when enabled.
 *
 * This is the gating template every questionnaire route follows: call it first,
 * before any auth or handler work.
 *
 * ```ts
 * export async function GET() {
 *   const blocked = await ensureQuestionnairesEnabled();
 *   if (blocked) return blocked;
 *   // …withAuth / withAdminAuth / handler work…
 * }
 * ```
 *
 * Server-only (resolves the flag from the database).
 */
export async function ensureQuestionnairesEnabled(): Promise<Response | null> {
  if (await isQuestionnairesEnabled()) {
    return null;
  }
  return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
}
