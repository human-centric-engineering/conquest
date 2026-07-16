/**
 * Route gate for the **alpha-only** admin session tooling (the session-ref browser). Applies the alpha
 * release-stage check, so the surface 404s — looking like a missing route rather than a 401 — unless
 * the product is in the `alpha` stage ({@link IS_ALPHA}, driven by the existing
 * `NEXT_PUBLIC_RELEASE_STAGE`).
 *
 * The gate lives on the API (not just the page) because the endpoint returns respondent-shaped data
 * (refs + statuses across every questionnaire) that is deliberately protected once alpha ends.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { IS_ALPHA } from '@/lib/app/release-stage';

/** Wrap an admin handler so it 404s unless the product is in the alpha stage. */
export function withAlphaSessionToolsEnabled<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    if (!IS_ALPHA) {
      return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
    }
    return handler(request, context);
  };
}
