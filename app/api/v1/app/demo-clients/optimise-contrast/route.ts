/**
 * Brand contrast — audit a demo client's theme and propose readable shades.
 *
 * POST /api/v1/app/demo-clients/optimise-contrast
 *   Admin-only. `{ theme, demoClientId? }` where `theme` is the nullable theme columns as the
 *   branding form currently holds them.
 *
 *   **The theme is sent, not loaded.** That is the whole reason this route takes a body at all. An
 *   admin presses "Check contrast" in the middle of adjusting colours, and the interesting state is
 *   the UNSAVED one in front of them — reading the row would audit the colours they have already
 *   moved on from and propose fixes to a theme that no longer exists.
 *
 *   Collection-scoped rather than `[id]`-scoped, for the same reason the brand import is: the
 *   create form has no client id yet, and a theme is worth checking before the client exists.
 *   `demoClientId` is optional context for cost attribution only — it is never read from or
 *   written to.
 *
 *   **Persists nothing.** The proposals reach a column only when the admin accepts them into the
 *   form and saves it, audited like any other demo-client edit.
 *
 *   **A theme with no problems is a 200, not a 404 or an empty body.** `outcome: 'clean'` carries a
 *   sentence saying so; an admin who pressed the button is owed an answer either way.
 *
 *   Gate order: withAdminAuth → per-admin optimiser sub-cap → shape → audit → advise.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { themeFieldsSchema } from '@/lib/app/questionnaire/theming';
import { optimiseContrast } from '@/lib/app/questionnaire/brand-contrast';
import { brandContrastLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * The body: the theme as the form holds it, plus optional cost context.
 *
 * Reuses `themeFieldsSchema` rather than declaring its own colour validators, so a hex this route
 * accepts is exactly a hex the PATCH would accept. A body that validated here and failed on save
 * would let an admin apply a proposal they can never store.
 */
const optimiseSchema = z.object({
  theme: themeFieldsSchema,
  demoClientId: z.string().trim().max(64).optional(),
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const adminId = session.user.id;

  const rl = brandContrastLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Brand contrast rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const parsed = optimiseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new APIError(
      'A theme is required, with every colour a hex like #5469d4',
      ErrorCodes.VALIDATION_ERROR,
      400
    );
  }

  const { theme } = parsed.data;
  const result = await optimiseContrast({
    // `resolveTheme` reads an absent key and an explicit null identically, so the partial body a
    // form sends needs no filling in. The four columns below are spelled out only because
    // `DemoClientTheme` declares them REQUIRED-but-nullable (they predate the optional ones), and
    // the schema makes every field optional — so they are normalised rather than defaulted.
    theme: {
      ...theme,
      ctaColor: theme.ctaColor ?? null,
      accentColor: theme.accentColor ?? null,
      logoUrl: theme.logoUrl ?? null,
      welcomeCopy: theme.welcomeCopy ?? null,
    },
    demoClientId: parsed.data.demoClientId,
  });

  log.info('Brand contrast audited a theme', {
    adminId,
    demoClientId: parsed.data.demoClientId,
    outcome: result.outcome,
    proposals: result.proposals.length,
    unfixable: result.unfixable.length,
    degraded: result.degraded,
  });

  return successResponse(result);
});
