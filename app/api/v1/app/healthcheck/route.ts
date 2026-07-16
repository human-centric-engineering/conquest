import { successResponse } from '@/lib/api/responses';

/**
 * Questionnaire app healthcheck / liveness probe.
 *
 * GET /api/v1/app/healthcheck
 *
 * Returns `200` `{ status: 'ok' }`.
 *
 * Unauthenticated by design (liveness probe). The route inherits the 100/min
 * `api` rate-limit cap automatically via the security middleware.
 */
export function GET(): Response {
  return successResponse({ status: 'ok' });
}
