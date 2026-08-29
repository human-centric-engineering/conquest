/**
 * Rasterise an SVG logo to PNG before it enters the image pipeline.
 *
 * Vector lockups are the norm for a modern site's header, so a brand import that could not handle
 * SVG would fail on exactly the logos worth having. But an SVG can never travel any further than
 * this function:
 *
 *  - **It has no magic bytes.** `validateImageMagicBytes` identifies a file by its signature and
 *    SVG is text, so it can never be recognised — nor should the validator be widened to sniff for
 *    `<svg`, which would mean accepting a format identified by a substring.
 *  - **It is a script host.** An SVG served from our own origin can carry `<script>` and external
 *    entity references. Storing one and rendering it in an invitation email or an export PDF would
 *    put attacker-authored markup inside our own document.
 *
 * So the vector is converted here and **only the raster is ever stored or served**. sharp does the
 * conversion with librsvg, which does not execute script.
 *
 * Returns null when the bytes are not an SVG, so the caller can pass a PNG or JPEG straight
 * through untouched.
 */

import sharp from 'sharp';

import { logger } from '@/lib/logging';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { MAX_INPUT_PIXELS } from '@/lib/app/questionnaire/theming';

/**
 * Width the vector is rendered at.
 *
 * Above the largest box any brand spec asks for (1200x1200), so `processImage` scales DOWN to the
 * spec afterwards and the stored file is never an upscale of a smaller render. Height follows the
 * artwork's own ratio — a wordmark rendered into a square would be letterboxed twice.
 */
const RASTER_WIDTH = 1600;

/** Enough of the head to find a root element, and far less than a whole file. */
const SNIFF_BYTES = 1024;

/** True when the bytes look like SVG — by content type, or by an `<svg` root in the first KB. */
function looksLikeSvg(buffer: Buffer, contentType: string | null): boolean {
  if (contentType?.includes('svg')) return true;
  const head = buffer.subarray(0, SNIFF_BYTES).toString('utf-8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Convert SVG bytes to PNG, or return null when they are not SVG.
 *
 * Throws an `APIError` when the bytes ARE an SVG but cannot be rendered — an admin who imported a
 * vector logo needs to know it failed, where returning the raw bytes would fail later with a
 * confusing "not an image" from the magic-byte check.
 */
export async function rasteriseSvg(
  buffer: Buffer,
  contentType: string | null,
  sourceUrl: string
): Promise<Buffer | null> {
  if (!looksLikeSvg(buffer, contentType)) return null;

  try {
    return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: RASTER_WIDTH, withoutEnlargement: false, fit: 'inside' })
      .png()
      .toBuffer();
  } catch (error) {
    logger.info('Brand import: an SVG logo could not be rasterised', {
      sourceUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new APIError(
      'That logo is an SVG we could not render. Save it as a PNG and upload it instead.',
      ErrorCodes.INVALID_FILE_TYPE,
      400
    );
  }
}
