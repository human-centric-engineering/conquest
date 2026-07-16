/**
 * Route gate for the **alpha-only** admin session tooling (the session-ref browser). Layers the alpha
 * release-stage check on top of the live-sessions gate, so the surface 404s — looking like a missing
 * route rather than a 401 — unless BOTH live-sessions is on AND the product is in the `alpha` stage
 * ({@link IS_ALPHA}, driven by the existing `NEXT_PUBLIC_RELEASE_STAGE`). Mirrors
 * `withRespondentReportEnabled` / `withLiveSessionsEnabled`.
 *
 * The gate lives on the API (not just the page) because the endpoint returns respondent-shaped data
 * (refs + statuses across every questionnaire) that is deliberately protected once alpha ends.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { IS_ALPHA } from '@/lib/app/release-stage';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';

/** Wrap an admin handler so it 404s unless live-sessions is on AND the product is in the alpha stage. */
export function withAlphaSessionToolsEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return withLiveSessionsEnabled<C>(async (request, context) => {
    if (!IS_ALPHA) {
      return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
    }
    return handler(request, context);
  });
}
