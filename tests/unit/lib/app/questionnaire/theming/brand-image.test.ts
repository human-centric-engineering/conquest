/**
 * Brand image specs — dimension rules for uploaded logos and banners, and the src
 * predicate that admits our own upload paths alongside https URLs.
 *
 * @see lib/app/questionnaire/theming/brand-image.ts
 */

import { describe, it, expect } from 'vitest';

import {
  BRAND_BANNER_SPEC,
  BRAND_LOGO_SPEC,
  isBrandImageSrc,
  recommendedSize,
  validateImageDimensions,
} from '@/lib/app/questionnaire/theming';

describe('validateImageDimensions — logo (any shape)', () => {
  it('accepts a wide wordmark and a tall device alike', () => {
    // The band letterboxes the logo, so shape is the admin's business.
    expect(validateImageDimensions({ width: 600, height: 100 }, BRAND_LOGO_SPEC).valid).toBe(true);
    expect(validateImageDimensions({ width: 100, height: 600 }, BRAND_LOGO_SPEC).valid).toBe(true);
    expect(validateImageDimensions({ width: 400, height: 400 }, BRAND_LOGO_SPEC).valid).toBe(true);
  });

  it('accepts an image sitting exactly on the minimum', () => {
    expect(
      validateImageDimensions(
        { width: BRAND_LOGO_SPEC.minWidth, height: BRAND_LOGO_SPEC.minHeight },
        BRAND_LOGO_SPEC
      ).valid
    ).toBe(true);
  });

  it('rejects an image below the minimum, naming both the rule and the measurement', () => {
    const result = validateImageDimensions({ width: 40, height: 20 }, BRAND_LOGO_SPEC);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error).toContain('80x40');
    expect(result.error).toContain('40x20');
  });

  it('accepts an image far above the max box — that is a resize, not a rejection', () => {
    expect(validateImageDimensions({ width: 4000, height: 3000 }, BRAND_LOGO_SPEC).valid).toBe(
      true
    );
  });
});

describe('validateImageDimensions — banner (4:1)', () => {
  it('accepts the recommended size', () => {
    expect(validateImageDimensions({ width: 1600, height: 400 }, BRAND_BANNER_SPEC).valid).toBe(
      true
    );
  });

  it('accepts the near-4:1 sizes designers actually export', () => {
    for (const size of [
      { width: 1500, height: 400 }, // 3.75:1
      { width: 1920, height: 480 }, // 4.0:1
      { width: 2000, height: 500 }, // 4.0:1
      { width: 1800, height: 420 }, // 4.29:1
    ]) {
      expect(validateImageDimensions(size, BRAND_BANNER_SPEC).valid).toBe(true);
    }
  });

  it('rejects a 16:9 hero and a square logo dropped in by mistake', () => {
    expect(validateImageDimensions({ width: 1920, height: 1080 }, BRAND_BANNER_SPEC).valid).toBe(
      false
    );
    expect(validateImageDimensions({ width: 1000, height: 1000 }, BRAND_BANNER_SPEC).valid).toBe(
      false
    );
  });

  it('explains a ratio rejection with the measured ratio and a size to aim for', () => {
    const result = validateImageDimensions({ width: 1600, height: 900 }, BRAND_BANNER_SPEC);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error).toContain('1.78:1');
    expect(result.error).toContain('1600x400');
  });

  it('checks the size floor before the ratio, so a tiny 4:1 strip is still rejected', () => {
    // 400x100 is a perfect 4:1 but far too small to fill a header band.
    const result = validateImageDimensions({ width: 400, height: 100 }, BRAND_BANNER_SPEC);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error).toContain('at least 800x200');
  });
});

describe('validateImageDimensions — decompression bombs', () => {
  it('rejects a huge image that satisfies every shape rule', () => {
    // 16000x16000 solid PNG: ~200KB on disk (under the file cap), valid magic bytes, way
    // over the size floor, and the logo spec has no aspect rule — so the pixel ceiling is
    // the only thing standing between this and ~1GB of decoded RGBA.
    const result = validateImageDimensions({ width: 16000, height: 16000 }, BRAND_LOGO_SPEC);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toMatch(/resolution is too large/i);
  });

  it('rejects a bomb shaped to pass the banner ratio too', () => {
    const result = validateImageDimensions({ width: 16000, height: 4000 }, BRAND_BANNER_SPEC);
    expect(result.valid).toBe(false);
  });

  it('still accepts a large but legitimate export', () => {
    // 4x the recommended banner — a plausible retina export, well under the ceiling.
    expect(validateImageDimensions({ width: 6400, height: 1600 }, BRAND_BANNER_SPEC)).toEqual({
      valid: true,
    });
  });
});

describe('recommendedSize', () => {
  it('renders the spec box as a WxH string for the admin hint', () => {
    expect(recommendedSize(BRAND_BANNER_SPEC)).toBe('1600x400');
    expect(recommendedSize(BRAND_LOGO_SPEC)).toBe('1200x1200');
  });
});

describe('isBrandImageSrc', () => {
  it('accepts absolute https URLs', () => {
    expect(isBrandImageSrc('https://acme.example/logo.png')).toBe(true);
  });

  it('accepts our own upload paths, which the local storage provider serves', () => {
    expect(isBrandImageSrc('/uploads/demo-clients/abc/logo/logo.png')).toBe(true);
    expect(isBrandImageSrc('/uploads/demo-clients/abc/logo/logo.png?v=123')).toBe(true);
  });

  it('rejects http, protocol-relative and other schemes', () => {
    expect(isBrandImageSrc('http://acme.example/logo.png')).toBe(false);
    expect(isBrandImageSrc('//acme.example/logo.png')).toBe(false);
    expect(isBrandImageSrc('javascript:alert(1)')).toBe(false);
    expect(isBrandImageSrc('data:image/png;base64,AAAA')).toBe(false);
  });

  it('rejects traversal and host-smuggling dressed up as an upload path', () => {
    // The relative branch must only ever address our own upload tree.
    expect(isBrandImageSrc('/uploads/../../etc/passwd')).toBe(false);
    expect(isBrandImageSrc('/uploads//evil.example/x.png')).toBe(false);
    expect(isBrandImageSrc('/uploads/..\\windows\\x.png')).toBe(false);
  });

  it('rejects other absolute paths — only /uploads/ is served as brand images', () => {
    expect(isBrandImageSrc('/etc/passwd')).toBe(false);
    expect(isBrandImageSrc('/admin/secret.png')).toBe(false);
  });

  it('rejects PERCENT-ENCODED traversal, which a literal ".." check would miss', () => {
    // %2e is a dot-segment to the URL parser, so these normalise out of /uploads/ in the
    // browser. The allowlisted charset makes them unrepresentable rather than filtered.
    expect(isBrandImageSrc('/uploads/%2e%2e/%2e%2e/admin')).toBe(false);
    expect(isBrandImageSrc('/uploads/%2E%2E/secret')).toBe(false);
    expect(isBrandImageSrc('/uploads/%5c%5cevil.example/x.png')).toBe(false);
  });

  it('rejects an upload path carrying a query beyond the cache-bust or a fragment', () => {
    expect(isBrandImageSrc('/uploads/logo.png?next=https://evil.example')).toBe(false);
    expect(isBrandImageSrc('/uploads/logo.png#frag')).toBe(false);
  });

  it('rejects an empty or malformed value', () => {
    expect(isBrandImageSrc('')).toBe(false);
    expect(isBrandImageSrc('not a url')).toBe(false);
  });
});
