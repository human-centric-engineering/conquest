/**
 * DEMO-ONLY (custom type): load a client's own typefaces and store them with us.
 *
 * POST   /api/v1/app/demo-clients/:id/fonts   `{ display?, body? }`
 * DELETE /api/v1/app/demo-clients/:id/fonts
 *
 * The six shipped pairings cover a lot of brands and will never cover a brand with its own face.
 * This names two Google Fonts families, fetches their woff2 files once, and stores them — so the
 * respondent surface can serve them back from our own origin. See
 * `lib/app/questionnaire/brand-import/google-fonts.ts` for why self-hosting rather than a
 * `<link>` to Google (short version: the CSP's `font-src` is `'self' data:` and widening it is a
 * platform edit this fork does not make).
 *
 * ## What this writes, and what it deliberately does not
 *
 * It writes the two family columns and the stored-file map **immediately**, exactly as a brand
 * image upload does and for the same reason: there is no draft state for a binary, and the
 * alternative strands orphaned objects in the bucket for every abandoned edit.
 *
 * It does NOT write `fontPairing`. That stays an ordinary form field the admin saves with
 * everything else — so loading a family and then changing their mind about the pairing costs
 * nothing, and the loaded faces sit inert until `fontPairing` is `custom`. Inert rather than lost
 * is the point: switching the picker away and back does not mean fetching Google again.
 *
 * A family that does not exist is a 400 naming it. There is no offline catalogue to validate
 * against — asking Google whether the family exists is both the check and the fetch.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { APIError, ErrorCodes, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getStorageClient, isStorageEnabled } from '@/lib/storage/client';
import { deleteByPrefix } from '@/lib/storage/upload';
import {
  CUSTOM_FONT_SLOTS,
  isCustomFontFamily,
  type CustomFontFiles,
  type CustomFontSlot,
} from '@/lib/app/questionnaire/theming';
import { narrowCustomFontFiles } from '@/lib/app/questionnaire/theming/theme';
import { fetchGoogleFontFaces } from '@/lib/app/questionnaire/brand-import/google-fonts';
import { brandImportLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** Fixed per client and slot, so re-loading a family overwrites rather than accumulating. */
const prefixFor = (id: string): string => `demo-clients/${id}/fonts/`;

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const clientIP = getClientIP(request);

  // Each call fetches a stylesheet plus three files per family from a third party — the same
  // outbound fan-out the brand import performs, so it answers to the same sub-cap.
  const rl = brandImportLimiter.check(session.user.id);
  if (!rl.success) {
    log.warn('Custom font load rate limit exceeded', {
      adminId: session.user.id,
      demoClientId: id,
    });
    return createRateLimitResponse(rl);
  }

  if (!isStorageEnabled()) {
    throw new APIError(
      'File storage is not configured, so custom fonts cannot be stored',
      ErrorCodes.STORAGE_NOT_CONFIGURED,
      503
    );
  }

  const client = await prisma.appDemoClient.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      customFontDisplay: true,
      customFontBody: true,
      customFontFiles: true,
    },
  });
  if (!client) throw new NotFoundError('Demo client not found');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const requested: Partial<Record<CustomFontSlot, string>> = {};
  for (const slot of CUSTOM_FONT_SLOTS) {
    const value = body?.[slot];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (!isCustomFontFamily(value)) {
      throw new APIError(
        `“${value.trim()}” is not a font name we can look up.`,
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }
    requested[slot] = value.trim();
  }

  if (Object.keys(requested).length === 0) {
    throw new APIError('Name at least one typeface', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const storage = getStorageClient();
  if (!storage) {
    throw new APIError('File storage is not configured', ErrorCodes.STORAGE_NOT_CONFIGURED, 503);
  }

  const files: CustomFontFiles = {};
  const loaded: Partial<Record<CustomFontSlot, string>> = {};

  for (const slot of CUSTOM_FONT_SLOTS) {
    const family = requested[slot];
    if (!family) continue;

    const fetched = await fetchGoogleFontFaces(family);
    if (!fetched.ok) {
      // A family the admin typed and we cannot find is their mistake to fix, and the message says
      // which name failed — so it is a 400, not a partial success they would have to notice.
      throw new APIError(fetched.reason, ErrorCodes.VALIDATION_ERROR, 400);
    }

    const stored: NonNullable<CustomFontFiles[CustomFontSlot]> = {};
    for (const face of fetched.faces) {
      const result = await storage.upload(face.buffer, {
        key: `${prefixFor(id)}${slot}-${face.weight}.woff2`,
        contentType: 'font/woff2',
        metadata: { demoClientId: id, slot, family, weight: String(face.weight) },
        public: true,
      });
      stored[`${face.weight}`] = result.url;
    }

    files[slot] = stored;
    loaded[slot] = family;
  }

  // MERGED, not replaced. A POST names the slots the admin asked us to load, and it is routinely
  // partial: the import dialog sends only the families that are still ticked, and the field's own
  // Load button sends only the ones that were typed. Writing `loaded.body ?? null` therefore
  // cleared a body face the client already had — silently, and orphaning its stored objects, since
  // nothing deletes the old prefix on POST. Clearing is what DELETE is for.
  const kept = narrowCustomFontFiles(client.customFontFiles);
  const merged = {
    display: loaded.display ?? client.customFontDisplay,
    body: loaded.body ?? client.customFontBody,
    files: { ...kept, ...files } satisfies CustomFontFiles,
  };

  await prisma.appDemoClient.update({
    where: { id },
    data: {
      customFontDisplay: merged.display,
      customFontBody: merged.body,
      customFontFiles: merged.files,
    },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_demo_client.update',
    entityType: 'app_demo_client',
    entityId: id,
    entityName: client.name,
    changes: {
      customFontDisplay: { from: client.customFontDisplay, to: merged.display },
      customFontBody: { from: client.customFontBody, to: merged.body },
    },
    metadata: {
      weights: Object.fromEntries(
        CUSTOM_FONT_SLOTS.map((slot) => [slot, Object.keys(merged.files[slot] ?? {})])
      ),
    },
    clientIp: clientIP,
  });

  log.info('Custom fonts loaded', { demoClientId: id, ...loaded });

  // Reports the MERGED state, not just this request's slots — the field renders it straight into
  // its "Stored:" line, and echoing only what was loaded would tell the admin the untouched slot
  // had been cleared when it had not.
  return successResponse({
    display: merged.display,
    body: merged.body,
    weights: Object.fromEntries(
      CUSTOM_FONT_SLOTS.map((slot) => [slot, Object.keys(merged.files[slot] ?? {}).map(Number)])
    ),
  });
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const clientIP = getClientIP(request);

  const client = await prisma.appDemoClient.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      customFontDisplay: true,
      customFontBody: true,
      customFontFiles: true,
    },
  });
  if (!client) throw new NotFoundError('Demo client not found');

  // Best-effort storage cleanup, columns cleared regardless: a stranded object is a tidiness
  // problem, but a column pointing at a deleted file is a page that renders in no font at all.
  if (isStorageEnabled()) {
    await deleteByPrefix(prefixFor(id));
  }

  await prisma.appDemoClient.update({
    where: { id },
    // `Prisma.DbNull`, not `null`: on a nullable Json column a bare null is ambiguous between the
    // SQL NULL and the JSON value `null`, so the client refuses it.
    data: {
      customFontDisplay: null,
      customFontBody: null,
      customFontFiles: Prisma.DbNull,
    },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_demo_client.update',
    entityType: 'app_demo_client',
    entityId: id,
    entityName: client.name,
    changes: {
      customFontDisplay: { from: client.customFontDisplay, to: null },
      customFontBody: { from: client.customFontBody, to: null },
    },
    clientIp: clientIP,
  });

  log.info('Custom fonts cleared', { demoClientId: id });

  return successResponse({ display: null, body: null, weights: {} });
});
