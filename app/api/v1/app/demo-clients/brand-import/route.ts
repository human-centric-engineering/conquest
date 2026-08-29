/**
 * Brand import — read a prospect's branding from their website, from screenshots of it, or both.
 *
 * POST /api/v1/app/demo-clients/brand-import
 *   Admin-only. Two request shapes, one result contract:
 *     - `application/json`  `{ url, demoClientId? }` — fetch and parse the site.
 *     - `multipart/form-data`  `url?`, `file` (repeatable, up to {@link MAX_SCREENSHOTS}),
 *       `demoClientId?` — measure the pictures, and the site too when an address came with them.
 *
 *   **An address and a picture are complementary, not alternative.** Only the site names the logo
 *   file, the typeface and `--brand-primary`; only a screenshot measures what the rendered page is
 *   actually painted in, which is the evidence that settles the ground and the ink. So the
 *   multipart shape accepts both and the analysis merges them — see the note on
 *   `analyseBrand`. Either alone still works, which is what an admin with only one of them has.
 *
 *   Gate order (screenshots): withAdminAuth → per-admin import sub-cap → count → size → magic bytes
 *   → pixel ceiling → minimum edge → analyse. Every file passes every gate: a bad second file is
 *   rejected exactly as a bad first one is.
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
import { analyseBrand } from '@/lib/app/questionnaire/brand-import';
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
 * Screenshots accepted in one import.
 *
 * More frames of the same site are genuinely better evidence — a hero, an interior page, a form —
 * but each is a full image decoded server-side and another attachment on the vision call, and past
 * three they describe the same brand again. The cap is stated to the admin rather than silently
 * dropping the extras, which would look like the import ignored what they sent.
 */
const MAX_SCREENSHOTS = 3;

/**
 * The JSON body of a URL import.
 *
 * `url` is only shape-checked here. The SSRF guard is applied inside the harvest, on the first
 * request AND on every redirect hop — validating once at the boundary would be the exact mistake
 * that lets `https://example.com` → 302 → `http://169.254.169.254/` through.
 */
const MAX_URL_LENGTH = 2048;

const urlImportSchema = z.object({
  url: z.string().trim().min(1).max(MAX_URL_LENGTH),
  demoClientId: z.string().trim().max(64).optional(),
});

/**
 * Put one uploaded file through every gate and hand back the bytes.
 *
 * Throws an `APIError` on anything malformed, which is the right shape for these: unlike "we could
 * not find a brand in there", a file that is not an image is fixed by sending a different file, not
 * by trying another route. Per file rather than per request, so the second picture is checked as
 * carefully as the first.
 */
async function readScreenshot(file: File): Promise<Buffer> {
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

  // Never trust the client-declared MIME. Nothing downstream reads the DETECTED type either —
  // `assignRoles` re-encodes every frame to PNG before it reaches a model, so the type attached to
  // the vision call is one we produced. This check earns its place as the gate that refuses a file
  // that is not an image at all.
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

  return buffer;
}

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

    const result = await analyseBrand({
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
  const files = formData.getAll('file').filter((entry): entry is File => entry instanceof File);
  const urlField = formData.get('url');
  const url = typeof urlField === 'string' && urlField.trim() ? urlField.trim() : undefined;

  if (files.length === 0 && !url) {
    throw new APIError('Add a website address or a screenshot', ErrorCodes.VALIDATION_ERROR, 400);
  }

  if (files.length > MAX_SCREENSHOTS) {
    throw new APIError(
      `Up to ${MAX_SCREENSHOTS} screenshots at a time — you sent ${files.length}.`,
      ErrorCodes.VALIDATION_ERROR,
      400
    );
  }

  if (url && url.length > MAX_URL_LENGTH) {
    throw new APIError('That website address is too long', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const screenshots: Buffer[] = [];
  for (const file of files) {
    screenshots.push(await readScreenshot(file));
  }

  const demoClientIdRaw = formData.get('demoClientId');
  const demoClientId =
    typeof demoClientIdRaw === 'string' && demoClientIdRaw ? demoClientIdRaw : undefined;

  const result = await analyseBrand({ url, screenshots, demoClientId });

  log.info('Brand import analysed an upload', {
    adminId,
    demoClientId,
    withUrl: Boolean(url),
    screenshots: screenshots.length,
    outcome: result.outcome,
    fields: Object.keys(result.fields).length,
    candidates: result.candidates.length,
    degraded: result.degraded,
  });

  return successResponse(result);
});
