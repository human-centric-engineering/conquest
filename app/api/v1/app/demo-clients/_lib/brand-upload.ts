/**
 * DEMO-ONLY (F7.2): shared upload/remove handlers for a demo client's brand images.
 *
 * The four routes (logo, dark logo, square mark, banner) differ only in which spec they
 * enforce and which column they write, so all are built from `brandImageHandlers(kind)`
 * rather than duplicated. The
 * shape follows the platform's avatar endpoint (`app/api/v1/users/me/avatar/route.ts`):
 * rate limit → storage-enabled gate → multipart parse → size → magic bytes → process →
 * upload → persist. Two things are new here:
 *
 *  1. DIMENSIONS. The platform has no dimension validator, so this measures the image
 *     (`readImageDimensions`) and checks it against the spec BEFORE processing. A banner
 *     of the wrong shape is rejected with its measured size in the message, not silently
 *     squashed into the band.
 *  2. FIT. `processImage` centre-crops to a square by default, which would destroy a
 *     wordmark. Every kind uses `fit: 'inside'` so aspect ratio survives — including the
 *     square mark, whose 1:1 shape is enforced on the way IN rather than imposed here.
 *
 * Keys are FIXED per client and kind (`demo-clients/<id>/logo.png`), so re-uploading
 * overwrites rather than accumulating orphans; the stored URL carries a `?v=` cache-bust
 * so browsers pick the new file up. Writes are audited like every other client edit.
 *
 * ## Two byte sources, one pipeline (brand import)
 *
 * POST accepts either a multipart upload or a JSON `{ sourceUrl }` naming an image on the open web
 * — how the brand importer re-hosts a logo it discovered on a prospect's site. Only the first step
 * differs: the URL branch fetches through the SSRF-guarded, redirect-revalidating fetcher and
 * rasterises SVG, then rejoins the SAME path (magic bytes → dimensions → `processImage` →
 * `storage.upload` → column → audit). Every guard therefore applies to both, which is the point of
 * splitting at the source rather than writing a second handler.
 *
 * Re-hosting rather than storing the remote URL is deliberate: `logoUrl` renders in invitation
 * emails and export PDFs, and a hotlink to someone else's CDN breaks the moment they move the file.
 * The importer falls back to the plain URL only when storage is not configured.
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
import { HarvestBudget, fetchResource } from '@/lib/app/questionnaire/brand-import';
import { rasteriseSvg } from '@/app/api/v1/app/demo-clients/_lib/rasterise-svg';
import {
  BRAND_IMAGE_SPECS,
  validateImageDimensions,
  type BrandImageKind,
} from '@/lib/app/questionnaire/theming';

/** Which column each kind writes. Keeps the Prisma update key off a template string. */
const COLUMN: Record<BrandImageKind, BrandImageColumn> = {
  logo: 'logoUrl',
  banner: 'bannerUrl',
  mark: 'logoMarkUrl',
  'logo-dark': 'logoDarkUrl',
};

/** The columns a brand-image upload may write. */
type BrandImageColumn = 'logoUrl' | 'bannerUrl' | 'logoMarkUrl' | 'logoDarkUrl';

/**
 * Every image column, selected on both handlers so the audit entry can record the value an
 * upload REPLACES. All four rather than just the one being written: `client[column]` is
 * indexed by the kind, so a partial selection would be a type error on the day a kind is
 * added — which is exactly how this stayed correct when two were.
 */
const IMAGE_COLUMNS = {
  logoUrl: true,
  bannerUrl: true,
  logoMarkUrl: true,
  logoDarkUrl: true,
} as const;

/** The two route handlers a brand-image kind exports. */
type BrandImageRoute = {
  POST: ReturnType<typeof withAdminAuth<{ id: string }>>;
  DELETE: ReturnType<typeof withAdminAuth<{ id: string }>>;
};

/**
 * Read the bytes out of a multipart upload.
 *
 * The byte cap is checked against the declared file size BEFORE the body is read into a Buffer, so
 * an oversized upload costs us nothing beyond the headers.
 */
async function bytesFromUpload(request: Request): Promise<Buffer> {
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
      { maxSize: maxSizeMB }
    );
  }

  return Buffer.from(await file.arrayBuffer());
}

/**
 * Fetch the bytes from an image on the open web — the brand importer re-hosting a discovered logo.
 *
 * Two things happen here that the upload branch does not need:
 *
 *  - **The SSRF-guarded fetcher**, re-validating on every redirect hop. This endpoint takes a URL
 *    from an admin and fetches it server-side, which is the exact shape of an SSRF, and a guard
 *    applied only to the first URL would be no guard at all.
 *  - **SVG rasterisation.** Vector logos are common and `MAGIC_BYTES` has no SVG signature — nor
 *    should it, since SVG is text and an XSS/XXE vector. So it is converted to PNG here and only
 *    the raster is ever stored or served.
 */
async function bytesFromSourceUrl(request: Request): Promise<Buffer> {
  const body = (await request.json().catch(() => null)) as { sourceUrl?: unknown } | null;
  const sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
  if (!sourceUrl) {
    throw new APIError('No image address provided', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const fetched = await fetchResource(
    sourceUrl,
    new HarvestBudget({
      maxRequests: 6,
      maxResourceBytes: getMaxFileSizeBytes(),
      maxTotalBytes: getMaxFileSizeBytes(),
      timeoutMs: 15_000,
    }),
    { accept: 'image/*' }
  );

  if (!fetched.ok) {
    throw new APIError(fetched.reason, ErrorCodes.VALIDATION_ERROR, 400);
  }

  const rasterised = await rasteriseSvg(fetched.buffer, fetched.contentType, sourceUrl);
  return rasterised ?? fetched.buffer;
}

/**
 * POST + DELETE for one brand-image kind.
 *
 * Returns both handlers so a route module is a two-line re-export.
 */
export function brandImageHandlers(kind: BrandImageKind): BrandImageRoute {
  const spec = BRAND_IMAGE_SPECS[kind];
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

    // Re-uploading over an existing image is the common case; an audit trail that always
    // said `from: null` would hide every overwrite (see IMAGE_COLUMNS).
    const client = await prisma.appDemoClient.findUnique({
      where: { id },
      select: { id: true, name: true, ...IMAGE_COLUMNS },
    });
    if (!client) {
      throw new NotFoundError('Demo client not found');
    }

    const buffer = request.headers.get('content-type')?.includes('application/json')
      ? await bytesFromSourceUrl(request)
      : await bytesFromUpload(request);

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
      select: { id: true, name: true, ...IMAGE_COLUMNS },
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
