import { successResponse } from '@/lib/api/responses';
import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';

/**
 * Questionnaire app healthcheck / liveness probe.
 *
 * GET /api/v1/app/healthcheck
 *
 * Flag-gated: returns `404` when `APP_QUESTIONNAIRES_ENABLED` is off (a disabled
 * app is indistinguishable from a route that doesn't exist), or `200`
 * `{ status: 'ok' }` when on.
 *
 * This is the gating template every `/api/v1/app/**` route follows — call
 * `ensureQuestionnairesEnabled()` first, before any auth or handler work
 * (feature routes then add `withAuth` / `withAdminAuth` after the gate).
 * Unauthenticated by design (liveness probe). The route inherits the 100/min
 * `api` rate-limit cap automatically via the security middleware.
 */
export async function GET(): Promise<Response> {
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;

  return successResponse({ status: 'ok' });
}
