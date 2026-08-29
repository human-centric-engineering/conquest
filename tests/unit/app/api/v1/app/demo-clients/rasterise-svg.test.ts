/**
 * Unit tests: SVG rasterisation on the brand-image upload path.
 *
 * The rule this enforces is a security one, not a convenience: an SVG must never be stored or
 * served. It has no magic bytes for `validateImageMagicBytes` to recognise, and it can carry
 * `<script>` and external entity references — which, rendered from our own origin inside an
 * invitation email or an export PDF, would put attacker-authored markup in our document. So the
 * vector is converted here and only the raster travels on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('recognises an SVG that carries an XML prolog ahead of its root element', async () => {
    // Real exports commonly lead with `<?xml ...?>` before the `<svg>` root — the sniff has to
    // look past the prolog rather than only matching a bare `<svg` at the very start.
    const prologued = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
        '<circle cx="20" cy="20" r="18" fill="#5469d4"/></svg>'
    );

    const png = await rasteriseSvg(prologued, null, 'https://acme.example/logo.svg');

    expect(png).not.toBeNull();
    expect(png?.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it('does not mistake a plain XML prolog with no svg root for SVG', async () => {
    // Same prolog, no `<svg` anywhere in it — the sniff must not fire on the prolog alone.
    const plainXml = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><catalog><item/></catalog>'
    );

    await expect(rasteriseSvg(plainXml, null, 'https://acme.example/data.xml')).resolves.toBeNull();
  });
});

describe('rasteriseSvg — malformed error normalisation', () => {
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('stringifies a non-Error value thrown during rasterisation', async () => {
    // sharp always throws real Errors in practice, but the catch handles ANY thrown value —
    // this proves the `error instanceof Error ? error.message : String(error)` fallback runs
    // rather than crashing on a thrown non-Error.
    vi.resetModules();
    vi.doMock('sharp', () => ({
      default: vi.fn(() => {
        // Deliberately a non-Error throw — the branch under test is the `instanceof Error`
        // fallback, which only a non-Error value exercises.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'sharp blew up';
      }),
    }));

    const { rasteriseSvg: freshRasteriseSvg } =
      await import('@/app/api/v1/app/demo-clients/_lib/rasterise-svg');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    await expect(
      freshRasteriseSvg(svg, 'image/svg+xml', 'https://acme.example/logo.svg')
    ).rejects.toThrow('Save it as a PNG');
  });
});
