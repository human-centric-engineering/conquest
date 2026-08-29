/**
 * DEMO-ONLY (custom type): serve one of a client's self-hosted typeface files.
 *
 * GET /api/v1/app/demo-clients/:id/font/:face      (`face` = `display-400`, `body-700`, …)
 *
 * ## Why this route exists at all
 *
 * The `@font-face` rules a custom pairing emits have to point somewhere the CSP allows, and
 * `font-src` is `'self' data:` with no app seam to widen it. Same-origin is therefore the only
 * option that does not require editing a platform file.
 *
 * It proxies the stored object rather than reading it through `storage.download()` deliberately:
 * **Vercel Blob declares `download: false`** (`lib/storage/providers/vercel-blob.ts`), which is the
 * likely production provider, so a download-based route would work in development and 404 in
 * production. Every provider produces a public URL; fetching that works everywhere.
 *
 * ## Unauthenticated, and correctly so
 *
 * A respondent answering a questionnaire is often not logged in, so the surface's own assets cannot
 * be. What that exposes is a typeface the client chose and Google already serves to the whole
 * internet — and only for a client id that already has one stored. Rate limiting is inherited from
 * the `/api/v1/**` catch-all in `lib/security/rate-limit-policy.ts`.
 *
 * The URL fetched is one WE wrote, from fonts.gstatic.com, into our own storage. It is still put
 * through the SSRF guard before use: the column is Json and a direct write or a restored backup
 * could put anything there, and this route would otherwise fetch it server-side on request.
 */

import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import {
  CUSTOM_FONT_SLOTS,
  CUSTOM_FONT_WEIGHTS,
  type CustomFontSlot,
  type CustomFontWeight,
} from '@/lib/app/questionnaire/theming';
import { narrowCustomFontFiles } from '@/lib/app/questionnaire/theming/theme';

/**
 * A year, immutable. The bytes at a given key never change in place — re-loading a family
 * overwrites the object, and a client who changes family changes the family NAME in the
 * `@font-face` rule too, so a stale cached file can never be applied to a different face.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `display-400` → the slot and weight, or null for anything we would not have written. */
function parseFace(face: string): { slot: CustomFontSlot; weight: CustomFontWeight } | null {
  const [slotPart, weightPart] = face.split('-');
  const slot = CUSTOM_FONT_SLOTS.find((candidate) => candidate === slotPart);
  const weight = CUSTOM_FONT_WEIGHTS.find((candidate) => String(candidate) === weightPart);
  return slot && weight ? { slot, weight } : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; face: string }> }
): Promise<Response> {
  const { id, face } = await params;

  const parsed = parseFace(face);
  if (!parsed) {
    return errorResponse('Unknown font face', { code: 'NOT_FOUND', status: 404 });
  }

  const client = await prisma.appDemoClient.findUnique({
    where: { id },
    select: { customFontFiles: true },
  });
  if (!client) {
    return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
  }

  const files = narrowCustomFontFiles(client.customFontFiles);
  const url = files[parsed.slot]?.[`${parsed.weight}`];
  if (!url) {
    // A weight this family never published. The browser synthesises it, so a 404 here is a normal
    // outcome rather than a fault — hence no logging.
    return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
  }

  const safety = checkSafeProviderUrl(url);
  if (!safety.ok) {
    logger.warn('Custom font: stored URL failed the safety check', { demoClientId: id, face });
    return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
  }

  let upstream: Response;
  try {
    // No redirects followed: this is our own storage URL, and a storage host that suddenly wants
    // to redirect us somewhere is not a case worth supporting on an unauthenticated route.
    upstream = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    logger.info('Custom font: stored file could not be read', {
      demoClientId: id,
      face,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
  }

  if (!upstream.ok) {
    return errorResponse('Not found', { code: 'NOT_FOUND', status: 404 });
  }

  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'Content-Type': 'font/woff2',
      'Cache-Control': CACHE_CONTROL,
      // The face is the same bytes for every viewer, so nothing here varies by requester.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
