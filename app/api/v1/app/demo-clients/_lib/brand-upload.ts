/**
 * DEMO-ONLY (F7.2): shared upload/remove handlers for a demo client's brand images.
 *
 * The logo and banner routes differ only in which spec they enforce and which column they
 * write, so both are built from `brandImageHandlers(kind)` rather than duplicated. The
 * shape follows the platform's avatar endpoint (`app/api/v1/users/me/avatar/route.ts`):
 * rate limit → storage-enabled gate → multipart parse → size → magic bytes → process →
 * upload → persist. Two things are new here:
 *
 *  1. DIMENSIONS. The platform has no dimension validator, so this measures the image
 *     (`readImageDimensions`) and checks it against the spec BEFORE processing. A banner
 *     of the wrong shape is rejected with its measured size in the message, not silently
 *     squashed into the band.
 *  2. FIT. `processImage` centre-crops to a square by default, which would destroy a
 *     wordmark. Both kinds use `fit: 'inside'` so aspect ratio survives.
 *
 * Keys are FIXED per client and kind (`demo-clients/<id>/logo.png`), so re-uploading
 * overwrites rather than accumulating orphans; the stored URL carries a `?v=` cache-bust
 * so browsers pick the new file up. Writes are audited like every other client edit.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { APIError, ErrorCodes, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { uploadLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getStorageClient, isStorageEnabled } from '@/lib/storage/client';
import { getMaxFileSizeBytes } from '@/lib/validations/storage';
import {
  processImage,
  readImageDimensions,
  validateImageMagicBytes,
  SUPPORTED_IMAGE_TYPES,
} from '@/lib/storage/image';
import { deleteByPrefix } from '@/lib/storage/upload';
import {
  BRAND_BANNER_SPEC,
  BRAND_LOGO_SPEC,
  validateImageDimensions,
  type BrandImageSpec,
} from '@/lib/app/questionnaire/theming';

export type BrandImageKind = 'logo' | 'banner';

const SPECS: Record<BrandImageKind, BrandImageSpec> = {
  logo: BRAND_LOGO_SPEC,
  banner: BRAND_BANNER_SPEC,
};

/** Which column each kind writes. Keeps the Prisma update key off a template string. */
const COLUMN: Record<BrandImageKind, 'logoUrl' | 'bannerUrl'> = {
  logo: 'logoUrl',
  banner: 'bannerUrl',
};

/** The two route handlers a brand-image kind exports. */
type BrandImageRoute = {
  POST: ReturnType<typeof withAdminAuth<{ id: string }>>;
  DELETE: ReturnType<typeof withAdminAuth<{ id: string }>>;
};

/**
 * POST + DELETE for one brand-image kind.
 *
 * Returns both handlers so a route module is a two-line re-export.
 */
export function brandImageHandlers(kind: BrandImageKind): BrandImageRoute {
  const spec = SPECS[kind];
  const column = COLUMN[kind];
  const contentType = spec.format === 'png' ? 'image/png' : 'image/jpeg';
  const extension = spec.format === 'png' ? 'png' : 'jpg';
  // Per-client, per-kind prefix. DELETE clears the whole prefix so a format change
  // (png ↔ jpg) can never strand the previous file.
  const prefixFor = (id: string) => `demo-clients/${id}/${kind}/`;

  const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id } = await params;

    const clientIP = getClientIP(request);
    const rateLimitResult = uploadLimiter.check(clientIP);
    if (!rateLimitResult.success) {
      log.warn('Brand image upload rate limit exceeded', { ip: clientIP, kind, demoClientId: id });
      return createRateLimitResponse(rateLimitResult);
    }

    if (!isStorageEnabled()) {
      throw new APIError(
        'File uploads are not configured — use an image URL instead',
        ErrorCodes.STORAGE_NOT_CONFIGURED,
        503
      );
    }

    // Both image columns are selected so the audit entry can record the value this upload
    // REPLACES. Re-uploading over an existing logo is the common case; an audit trail that
    // always says `from: null` would hide every overwrite.
    const client = await prisma.appDemoClient.findUnique({
      where: { id },
      select: { id: true, name: true, logoUrl: true, bannerUrl: true },
    });
    if (!client) {
      throw new NotFoundError('Demo client not found');
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      throw new APIError('No file provided', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const maxSize = getMaxFileSizeBytes();
    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      throw new APIError(
        `File size exceeds maximum of ${maxSizeMB} MB`,
        ErrorCodes.FILE_TOO_LARGE,
        400,
        {
          maxSize: maxSizeMB,
        }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Never trust the client-declared MIME.
    const validation = validateImageMagicBytes(buffer);
    if (!validation.valid) {
      throw new APIError(
        validation.error || 'Invalid image format',
        ErrorCodes.INVALID_FILE_TYPE,
        400,
        { supportedTypes: SUPPORTED_IMAGE_TYPES }
      );
    }

    // Dimensions before processing: reject rather than reshape.
    const dimensions = await readImageDimensions(buffer);
    if (!dimensions) {
      throw new APIError('Could not read image dimensions', ErrorCodes.INVALID_FILE_TYPE, 400);
    }
    const dimensionCheck = validateImageDimensions(dimensions, spec);
    if (!dimensionCheck.valid) {
      throw new APIError(dimensionCheck.error, ErrorCodes.VALIDATION_ERROR, 400, {
        width: dimensions.width,
        height: dimensions.height,
        expected: {
          minWidth: spec.minWidth,
          minHeight: spec.minHeight,
          aspectRatio: spec.aspectRatio,
        },
      });
    }

    // fit: 'inside' — preserve aspect ratio. The default 'cover' would centre-crop the
    // image to a square, which is exactly wrong for a wordmark or a 4:1 banner.
    const processed = await processImage(buffer, {
      maxWidth: spec.maxWidth,
      maxHeight: spec.maxHeight,
      format: spec.format,
      fit: 'inside',
    });

    const storage = getStorageClient();
    if (!storage) {
      throw new APIError('File uploads are not configured', ErrorCodes.STORAGE_NOT_CONFIGURED, 503);
    }

    const result = await storage.upload(processed.buffer, {
      key: `${prefixFor(id)}${kind}.${extension}`,
      contentType,
      metadata: { demoClientId: id, kind, uploadedAt: new Date().toISOString() },
      public: true,
    });

    // Cache-bust: the key is fixed, so without this browsers keep the previous image.
    const url = `${result.url}?v=${Date.now()}`;

    await prisma.appDemoClient.update({
      where: { id },
      data: { [column]: url },
      select: { id: true },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_demo_client.update',
      entityType: 'app_demo_client',
      entityId: id,
      entityName: client.name,
      changes: { [column]: { from: client[column], to: url } },
      metadata: { kind, width: processed.width, height: processed.height },
      clientIp: clientIP,
    });

    log.info('Brand image uploaded', {
      demoClientId: id,
      kind,
      width: processed.width,
      height: processed.height,
      size: processed.buffer.length,
    });

    return successResponse({
      url,
      kind,
      width: processed.width,
      height: processed.height,
      size: processed.buffer.length,
    });
  });

  const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id } = await params;
    const clientIP = getClientIP(request);

    const client = await prisma.appDemoClient.findUnique({
      where: { id },
      select: { id: true, name: true, logoUrl: true, bannerUrl: true },
    });
    if (!client) {
      throw new NotFoundError('Demo client not found');
    }

    // Best-effort storage cleanup. The column is cleared regardless: a stranded object is
    // a tidiness problem, but a column still pointing at a deleted file is a broken page.
    if (isStorageEnabled()) {
      await deleteByPrefix(prefixFor(id));
    }

    await prisma.appDemoClient.update({ where: { id }, data: { [column]: null } });

    logAdminAction({
      userId: session.user.id,
      action: 'app_demo_client.update',
      entityType: 'app_demo_client',
      entityId: id,
      entityName: client.name,
      changes: { [column]: { from: client[column], to: null } },
      metadata: { kind },
      clientIp: clientIP,
    });

    log.info('Brand image removed', { demoClientId: id, kind });
    return successResponse({ success: true, kind });
  });

  return { POST, DELETE };
}
