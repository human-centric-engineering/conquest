/**
 * Brand import — read a prospect's branding from their website or from a screenshot of it.
 *
 * POST /api/v1/app/demo-clients/brand-import
 *   Admin-only. Two request shapes, one result contract:
 *     - `application/json`  `{ url, demoClientId? }`   — fetch and parse the site.
 *     - `multipart/form-data`  `file`, `demoClientId?` — measure a screenshot.
 *
 *   Gate order (screenshot): withAdminAuth → per-admin import sub-cap → size → magic bytes →
 *   pixel ceiling → minimum edge → analyse.
 *   Gate order (url): withAdminAuth → per-admin import sub-cap → shape → harvest, which applies
 *   the SSRF guard on every redirect hop of every request it makes and works to a fixed budget of
 *   requests, bytes and wall clock.
 *
 *   **Persists nothing, and stores nothing.** The image is analysed in memory and dropped — a
 *   screenshot of someone else's website is evidence for a decision, not an asset we have any
 *   reason to keep. The proposals reach the column only when the admin accepts them into the form
 *   and saves it, audited like any other demo-client edit.
 *
 *   **A failed read is a 200, not a 500.** "We could not find a brand in that image" is an ordinary
 *   answer with a next step attached (`BrandImportResult.outcome` / `.nextStep`), and the dialog
 *   renders it as guidance. Only a genuine defect throws. The 4xx cases below are the ones where
 *   the request itself is malformed — no file, wrong bytes, a decompression bomb — which the admin
 *   fixes by sending a different file rather than by trying a different route.
 *
 *   Collection-scoped rather than `[id]`-scoped on purpose: the create form has no client id yet,
 *   and colours are worth importing before the client exists. `demoClientId` is optional context
 *   for cost attribution only — it is never written to.
 *
 *   The sibling static segment resolves ahead of `[id]`, so this path never reaches the
 *   single-client handler.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getMaxFileSizeBytes } from '@/lib/validations/storage';
import {
  SUPPORTED_IMAGE_TYPES,
  readImageDimensions,
  validateImageMagicBytes,
} from '@/lib/storage/image';
import { MAX_INPUT_PIXELS } from '@/lib/app/questionnaire/theming';
import { analyseScreenshot, analyseUrl } from '@/lib/app/questionnaire/brand-import';
import { brandImportLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * Smallest useful screenshot edge.
 *
 * Below this there is not enough page in the frame for the area shares to mean anything — a 200px
 * crop of a header is all header, so its "page background" is the band. Stated as a floor the admin
 * can act on rather than silently producing a confident wrong palette.
 */
const MIN_SCREENSHOT_EDGE = 320;

/**
 * The JSON body of a URL import.
 *
 * `url` is only shape-checked here. The SSRF guard is applied inside the harvest, on the first
 * request AND on every redirect hop — validating once at the boundary would be the exact mistake
 * that lets `https://example.com` → 302 → `http://169.254.169.254/` through.
 */
const urlImportSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  demoClientId: z.string().trim().max(64).optional(),
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const adminId = session.user.id;

  const rl = brandImportLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Brand import rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // The two shapes are distinguished by content type rather than by a mode flag: a JSON body and a
  // multipart body are already different requests, and a flag that could disagree with the payload
  // is a third thing to keep in step.
  if (request.headers.get('content-type')?.includes('application/json')) {
    const parsed = urlImportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new APIError('A website address is required', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const result = await analyseUrl({
      url: parsed.data.url,
      demoClientId: parsed.data.demoClientId,
    });

    log.info('Brand import analysed a website', {
      adminId,
      demoClientId: parsed.data.demoClientId,
      outcome: result.outcome,
      fields: Object.keys(result.fields).length,
      candidates: result.candidates.length,
      degraded: result.degraded,
    });

    return successResponse(result);
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new APIError('No screenshot provided', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const maxSize = getMaxFileSizeBytes();
  if (file.size > maxSize) {
    const maxSizeMB = Math.round(maxSize / (1024 * 1024));
    throw new APIError(
      `Screenshot exceeds the maximum of ${maxSizeMB} MB`,
      ErrorCodes.FILE_TOO_LARGE,
      400,
      { maxSize: maxSizeMB }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Never trust the client-declared MIME — the detected type is also what gets attached to the
  // vision call, so a wrong one would reach the provider as a lie about the payload.
  const validation = validateImageMagicBytes(buffer);
  if (!validation.valid || !validation.detectedType) {
    throw new APIError(
      validation.error || 'That file is not an image we can read',
      ErrorCodes.INVALID_FILE_TYPE,
      400,
      { supportedTypes: SUPPORTED_IMAGE_TYPES }
    );
  }

  const dimensions = await readImageDimensions(buffer);
  if (!dimensions) {
    throw new APIError('Could not read the image dimensions', ErrorCodes.INVALID_FILE_TYPE, 400);
  }

  // Before any decode. A solid-colour 16000x16000 PNG is ~200KB on disk and ~1GB decoded, so it
  // clears the byte cap and every other check; the header read that answers this costs nothing.
  if (dimensions.width * dimensions.height > MAX_INPUT_PIXELS) {
    throw new APIError(
      `That image is too large to analyse — it is ${dimensions.width}x${dimensions.height}px.`,
      ErrorCodes.VALIDATION_ERROR,
      400
    );
  }

  if (dimensions.width < MIN_SCREENSHOT_EDGE || dimensions.height < MIN_SCREENSHOT_EDGE) {
    throw new APIError(
      `A screenshot needs to be at least ${MIN_SCREENSHOT_EDGE}x${MIN_SCREENSHOT_EDGE}px — ` +
        `this one is ${dimensions.width}x${dimensions.height}px. Capture more of the page.`,
      ErrorCodes.VALIDATION_ERROR,
      400
    );
  }

  const demoClientIdRaw = formData.get('demoClientId');
  const demoClientId =
    typeof demoClientIdRaw === 'string' && demoClientIdRaw ? demoClientIdRaw : undefined;

  const result = await analyseScreenshot({
    buffer,
    mediaType: validation.detectedType,
    demoClientId,
  });

  log.info('Brand import analysed a screenshot', {
    adminId,
    demoClientId,
    outcome: result.outcome,
    fields: Object.keys(result.fields).length,
    candidates: result.candidates.length,
    degraded: result.degraded,
  });

  return successResponse(result);
});
