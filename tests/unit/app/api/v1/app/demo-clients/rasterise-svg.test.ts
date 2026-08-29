/**
 * Unit tests: SVG rasterisation on the brand-image upload path.
 *
 * The rule this enforces is a security one, not a convenience: an SVG must never be stored or
 * served. It has no magic bytes for `validateImageMagicBytes` to recognise, and it can carry
 * `<script>` and external entity references — which, rendered from our own origin inside an
 * invitation email or an export PDF, would put attacker-authored markup in our document. So the
 * vector is converted here and only the raster travels on.
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import { rasteriseSvg } from '@/app/api/v1/app/demo-clients/_lib/rasterise-svg';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">' +
    '<rect width="200" height="60" fill="#5469d4"/></svg>'
);

describe('rasteriseSvg', () => {
  it('converts an SVG to a PNG the magic-byte check can recognise', async () => {
    const png = await rasteriseSvg(SVG, 'image/svg+xml', 'https://acme.example/logo.svg');

    expect(png).not.toBeNull();
    // PNG signature — this is precisely what the upload pipeline checks next.
    expect(png?.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it('recognises an SVG by its content even when the server mislabels the type', async () => {
    // CDNs commonly serve SVG as `application/octet-stream` or `text/plain`.
    const png = await rasteriseSvg(SVG, 'application/octet-stream', 'https://acme.example/l.svg');
    expect(png).not.toBeNull();
  });

  it('renders wider than any brand spec asks for, so the stored file is never an upscale', async () => {
    const png = await rasteriseSvg(SVG, 'image/svg+xml', 'https://acme.example/logo.svg');
    const { width } = await sharp(png as Buffer).metadata();

    // The largest box a spec asks for is 1200; processImage scales DOWN from here.
    expect(width).toBeGreaterThanOrEqual(1200);
  });

  it('preserves the artwork’s aspect ratio', async () => {
    const png = await rasteriseSvg(SVG, 'image/svg+xml', 'https://acme.example/logo.svg');
    const { width, height } = await sharp(png as Buffer).metadata();

    // A wordmark rendered into a square would be letterboxed twice — once here, once in the band.
    expect(width / height).toBeCloseTo(200 / 60, 1);
  });

  it('passes a raster straight through untouched', async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#5469d4' },
    })
      .png()
      .toBuffer();

    await expect(
      rasteriseSvg(png, 'image/png', 'https://acme.example/logo.png')
    ).resolves.toBeNull();
  });

  it('tells the admin plainly when an SVG cannot be rendered', async () => {
    const broken = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><this is not markup');

    // Returning the raw bytes would fail later with a confusing "not an image" from the magic-byte
    // check, several steps away from the actual cause.
    await expect(
      rasteriseSvg(broken, 'image/svg+xml', 'https://acme.example/logo.svg')
    ).rejects.toThrow('Save it as a PNG');
  });
});
