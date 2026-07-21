/**
 * DEMO-ONLY (F7.2): brand image specs — what a demo client may upload as a logo or a
 * banner, and how the upload is checked before it is accepted.
 *
 * Two images, two very different jobs, so two specs:
 *  - LOGO   — a wordmark or device of ANY aspect ratio, letterboxed into the band's
 *             fixed slot. Only a floor (too small reads as blurry) and a ceiling
 *             (pointless bytes). Output PNG: logos need transparency, and the invitation
 *             email and export PDFs both render this file, where WebP support is patchy.
 *  - BANNER — replaces the whole header band edge-to-edge, so its shape matters as much
 *             as its size. Enforced against a target ratio within a tolerance, because a
 *             square image stretched across a 4:1 band is unusable. Output JPEG: banners
 *             are photographic and transparency is meaningless once it fills the band.
 *
 * Pure: no Prisma / Next / sharp. The route measures the image (`readImageDimensions`)
 * and hands the numbers here, so the same rules are testable in isolation and can be
 * mirrored client-side for a pre-upload check that never hits the network.
 */

/**
 * Pixel ceiling on an ACCEPTED upload, independent of the byte cap.
 *
 * `maxWidth`/`maxHeight` below are a resize box, not a rejection threshold, so without
 * this a decompression bomb walks straight through: a solid-colour 16000x16000 PNG is
 * ~200KB on disk (far under the 5MB file cap) but ~1GB once sharp decodes it to raw
 * RGBA. It also clears every other gate — valid magic bytes, over the size floor, and
 * the logo spec has no aspect rule at all. Dimensions are read from the header before
 * any decode, so this costs nothing.
 *
 * 40M px is ~8x the largest legitimate upload (a 1600x400 banner is 0.64M) and still
 * ~160MB decoded, which is survivable.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/** A dimension contract an uploaded brand image must satisfy. */
export interface BrandImageSpec {
  /** Human label used in error copy ("Logo" / "Banner"). */
  label: string;
  /** Smallest acceptable pixel dimensions — below this the image reads as blurry. */
  minWidth: number;
  minHeight: number;
  /**
   * The box the stored image is scaled to fit inside (aspect ratio preserved, never
   * enlarged). Not a rejection threshold: anything larger is accepted and scaled down.
   */
  maxWidth: number;
  maxHeight: number;
  /**
   * Required width ÷ height, or null to accept any shape.
   *
   * `aspectTolerance` is a FRACTION of the target ratio, so the window scales with the
   * ratio itself rather than being a flat number that is generous at 1:1 and punishing
   * at 4:1.
   */
  aspectRatio: number | null;
  aspectTolerance: number;
  /** Stored output format. */
  format: 'png' | 'jpeg';
}

/**
 * Logo: any shape. The band letterboxes it into a fixed 192x40 slot (`bg-contain`), so
 * shape is the admin's business — we only guard against unusably small files and
 * needlessly large ones. The 1200x1200 ceiling comfortably covers a 2x-density render of
 * the largest slot the logo appears in.
 */
export const BRAND_LOGO_SPEC: BrandImageSpec = {
  label: 'Logo',
  minWidth: 80,
  minHeight: 40,
  maxWidth: 1200,
  maxHeight: 1200,
  aspectRatio: null,
  aspectTolerance: 0,
  format: 'png',
};

/**
 * Banner: 4:1, targeting 1600x400. The +/-12% ratio window accepts the sizes designers
 * actually export around this shape (1600x400, 1500x400, 1920x480) while still rejecting
 * a 16:9 hero or a square logo dropped in by mistake.
 */
export const BRAND_BANNER_SPEC: BrandImageSpec = {
  label: 'Banner',
  minWidth: 800,
  minHeight: 200,
  maxWidth: 1600,
  maxHeight: 400,
  aspectRatio: 4,
  aspectTolerance: 0.12,
  format: 'jpeg',
};

/** The recommended dimensions to show in the admin UI, derived from the spec. */
export function recommendedSize(spec: BrandImageSpec): string {
  return `${spec.maxWidth}x${spec.maxHeight}`;
}

/**
 * Check measured dimensions against a spec.
 *
 * Returns a human error naming BOTH what was required and what was measured — an admin
 * whose export is rejected needs to know which way to correct it, and "invalid image"
 * sends them guessing.
 */
export function validateImageDimensions(
  dimensions: { width: number; height: number },
  spec: BrandImageSpec
): { valid: true } | { valid: false; error: string } {
  const { width, height } = dimensions;

  // Before the shape rules: a bomb can satisfy every one of them.
  if (width * height > MAX_INPUT_PIXELS) {
    return {
      valid: false,
      error: `${spec.label} resolution is too large — this image is ${width}x${height}px.`,
    };
  }

  if (width < spec.minWidth || height < spec.minHeight) {
    return {
      valid: false,
      error: `${spec.label} must be at least ${spec.minWidth}x${spec.minHeight}px — this image is ${width}x${height}px.`,
    };
  }

  if (spec.aspectRatio !== null) {
    const ratio = width / height;
    const drift = Math.abs(ratio - spec.aspectRatio) / spec.aspectRatio;
    if (drift > spec.aspectTolerance) {
      return {
        valid: false,
        error:
          `${spec.label} must be roughly ${spec.aspectRatio}:1 — ` +
          `this image is ${width}x${height}px (${ratio.toFixed(2)}:1). ` +
          `Try ${recommendedSize(spec)}px.`,
      };
    }
  }

  return { valid: true };
}

/**
 * True for a brand image source we are willing to render: an absolute `https://` URL, or
 * an app-relative upload path.
 *
 * The relative case exists because the LOCAL storage provider serves uploads from
 * `public/uploads/`, i.e. `/uploads/...` on our own origin — an https-only rule would
 * reject every locally-uploaded logo. It is deliberately narrow: a leading `/uploads/`
 * and no protocol, host, or `..` traversal, so it can only ever address our own upload
 * tree and never becomes an open redirect or an SSRF lever.
 *
 * The relative branch is a POSITIVE allowlist, not a blocklist of bad substrings. A
 * blocklist misses percent-encoded traversal — `%2e%2e` is a dot-segment to the URL
 * parser, so `/uploads/%2e%2e/%2e%2e/admin` normalises to `/admin` in the browser and
 * would slip past a literal `..` check. Restricting the charset to what an upload key
 * can actually contain makes that unrepresentable, and keeps the docblock claim above
 * true of the code rather than merely of the intent.
 */
const UPLOAD_PATH_PATTERN = /^\/uploads\/[A-Za-z0-9._\-/]+(?:\?v=\d+)?$/;

export function isBrandImageSrc(value: string): boolean {
  if (value.startsWith('/uploads/')) {
    return UPLOAD_PATH_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
