/**
 * QR PNG rasterisation, clipboard write, and download trigger.
 *
 * happy-dom provides no 2D canvas context and no `Path2D`, so the drawing path is exercised
 * against an instrumented stub context. The assertions target the *geometry this module
 * computes* — background fill, module scale factor, logo plate placement — not the fact that
 * a spy was called. Whether the resulting bitmap actually scans is verified out-of-band by
 * decoding real rendered output (see `.context/ui/qr-codes.md`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQrMatrix, qrLogoMarkRect, qrLogoRect, qrPathData } from '@/lib/app/qr/qr-matrix';
import {
  QR_LOGO_SRC,
  canCopyImages,
  copyPngToClipboard,
  downloadBlob,
  renderQrPngBlob,
} from '@/lib/app/qr/render-qr-png';

const URL_UNDER_TEST = 'https://conquest.example.com/q/clx1234567890abcdef';

interface StubContext {
  calls: { fillRect: number[][]; scale: number[][]; roundRect: number[][]; drawImage: unknown[][] };
  fillStyles: string[];
  /** The `d` string of each Path2D handed to `ctx.fill` — the matrix→canvas link. */
  filledPaths: (string | undefined)[];
  /** The mimetype the source asked `toBlob` for, rather than one the stub invents. */
  requestedBlobType?: string;
}

/** Build a canvas stub whose 2D context records the geometry it was asked to draw. */
function stubCanvas(options: { blob?: Blob | null } = {}) {
  const record: StubContext = {
    calls: { fillRect: [], scale: [], roundRect: [], drawImage: [] },
    fillStyles: [],
    filledPaths: [],
  };

  const ctx = {
    set fillStyle(value: string) {
      record.fillStyles.push(value);
    },
    get fillStyle() {
      return record.fillStyles[record.fillStyles.length - 1] ?? '';
    },
    fillRect: (...args: number[]) => record.calls.fillRect.push(args),
    scale: (...args: number[]) => record.calls.scale.push(args),
    roundRect: (...args: number[]) => record.calls.roundRect.push(args),
    drawImage: (...args: unknown[]) => record.calls.drawImage.push(args),
    fill: (path?: { d?: string }) => record.filledPaths.push(path?.d),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    clip: vi.fn(),
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (cb: (b: Blob | null) => void, type?: string) => {
      record.requestedBlobType = type;
      // Built from the type the source asked for, so the mimetype assertion reflects the
      // real call rather than a literal this stub invented.
      cb(options.blob === undefined ? new Blob(['png'], { type: type ?? '' }) : options.blob);
    },
  };

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return canvas as unknown as HTMLCanvasElement;
    return originalCreateElement.call(document, tag);
  });

  return record;
}

const originalCreateElement = document.createElement;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  // `Path2D` is absent in happy-dom; the module constructs one from the matrix path.
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(public d?: string) {}
    }
  );

  // Images never load in happy-dom, so resolve the logo immediately.
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // navigator.clipboard is redefined via defineProperty below, which neither of the above
  // undoes — restore the original descriptor so the stub can't outlive its test.
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('renderQrPngBlob', () => {
  it('produces a PNG blob for an encodable URL', async () => {
    const record = stubCanvas();

    const blob = await renderQrPngBlob(URL_UNDER_TEST);

    // Asserted against what the source asked the canvas for, not a stub-chosen literal.
    expect(record.requestedBlobType).toBe('image/png');
    expect(blob.type).toBe('image/png');
  });

  it('fills the exact module path derived from the matrix', async () => {
    const record = stubCanvas();

    await renderQrPngBlob(URL_UNDER_TEST, { pixelSize: 512 });

    // Pins the matrix→canvas link: the bitmap is drawn from the same path the SVG uses.
    expect(record.filledPaths[0]).toBe(qrPathData(createQrMatrix(URL_UNDER_TEST)));
  });

  it('paints a white field before the modules, so the code is never transparent', async () => {
    const record = stubCanvas();

    await renderQrPngBlob(URL_UNDER_TEST, { pixelSize: 512 });

    expect(record.fillStyles[0]).toBe('#ffffff');
    expect(record.calls.fillRect[0]).toEqual([0, 0, 512, 512]);
  });

  it('scales module units to pixels by the symbol span, including the quiet zone', async () => {
    const record = stubCanvas();
    const { span } = createQrMatrix(URL_UNDER_TEST);

    await renderQrPngBlob(URL_UNDER_TEST, { pixelSize: 512 });

    // Getting this wrong is what crops the quiet zone and breaks scanning.
    expect(record.calls.scale[0]).toEqual([512 / span, 512 / span]);
  });

  it('centres the logo plate using the shared geometry', async () => {
    const record = stubCanvas();
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const expected = qrLogoRect(matrix);
    const scale = 512 / matrix.span;

    await renderQrPngBlob(URL_UNDER_TEST, { pixelSize: 512 });

    const [plateX, plateY, plateSide] = record.calls.roundRect[0];
    expect(plateX).toBeCloseTo(expected.x * scale);
    expect(plateY).toBeCloseTo(expected.y * scale);
    expect(plateSide).toBeCloseTo(expected.side * scale);
    // Plate centre must coincide with the canvas centre.
    expect(plateX + plateSide / 2).toBeCloseTo(256);
  });

  it('draws the mark at exactly the shared geometry the SVG uses', async () => {
    const record = stubCanvas();
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const expected = qrLogoMarkRect(matrix);
    const scale = 512 / matrix.span;

    await renderQrPngBlob(URL_UNDER_TEST, { pixelSize: 512 });

    // Pins the PNG to `qrLogoMarkRect`, the same function the inline SVG renders from —
    // the two hardcoded their own inset before, and could drift apart.
    // roundRect(x, y, width, height, radius) — five args, so radius is index 4.
    const [markX, markY, markWidth, markHeight, markRadius] = record.calls.roundRect[1];
    expect(markX).toBeCloseTo(expected.x * scale);
    expect(markY).toBeCloseTo(expected.y * scale);
    expect(markWidth).toBeCloseTo(expected.side * scale);
    expect(markHeight).toBeCloseTo(expected.side * scale);
    expect(markRadius).toBeCloseTo(expected.radius * scale);

    // ...and the image is drawn into that same box.
    expect(record.calls.drawImage).toHaveLength(1);
    expect(record.calls.drawImage[0].slice(1)).toEqual([
      expected.x * scale,
      expected.y * scale,
      expected.side * scale,
      expected.side * scale,
    ]);
  });

  it('defaults to a print-safe 1024px export', async () => {
    const record = stubCanvas();

    await renderQrPngBlob(URL_UNDER_TEST);

    expect(record.calls.fillRect[0]).toEqual([0, 0, 1024, 1024]);
  });

  it('rejects when the text cannot be encoded', async () => {
    stubCanvas();

    await expect(renderQrPngBlob('')).rejects.toThrow(/non-empty/);
  });

  it('rejects when no 2D context is available', async () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => null,
    } as unknown as HTMLCanvasElement);

    await expect(renderQrPngBlob(URL_UNDER_TEST)).rejects.toThrow(/context unavailable/);
  });

  it('rejects when the canvas yields no blob', async () => {
    stubCanvas({ blob: null });

    await expect(renderQrPngBlob(URL_UNDER_TEST)).rejects.toThrow(/no blob/);
  });

  it('rejects when the centre mark fails to load', async () => {
    stubCanvas();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      }
    );

    await expect(renderQrPngBlob(URL_UNDER_TEST)).rejects.toThrow(/Failed to load QR logo/);
  });

  it('points at a same-origin mark, so the canvas is never tainted', () => {
    expect(QR_LOGO_SRC.startsWith('/')).toBe(true);
  });
});

describe('canCopyImages', () => {
  it('reports true when the browser exposes ClipboardItem and clipboard.write', () => {
    vi.stubGlobal('ClipboardItem', class {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn() },
      configurable: true,
    });

    expect(canCopyImages()).toBe(true);
  });

  it('reports false when ClipboardItem is missing', () => {
    vi.stubGlobal('ClipboardItem', undefined);

    expect(canCopyImages()).toBe(false);
  });

  it('reports false when clipboard.write is missing', () => {
    vi.stubGlobal('ClipboardItem', class {});
    Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });

    expect(canCopyImages()).toBe(false);
  });
});

describe('copyPngToClipboard', () => {
  const blob = new Blob(['png'], { type: 'image/png' });

  it('writes the blob as an image/png clipboard item', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const items: Record<string, Blob>[] = [];
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data: Record<string, Blob>) {
          items.push(data);
        }
      }
    );
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });

    await expect(copyPngToClipboard(blob)).resolves.toBe(true);
    expect(items[0]['image/png']).toBe(blob);
    expect(write).toHaveBeenCalledOnce();
  });

  it('resolves false when the clipboard write is denied', async () => {
    vi.stubGlobal('ClipboardItem', class {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    await expect(copyPngToClipboard(blob)).resolves.toBe(false);
  });

  it('resolves false without attempting a write when unsupported', async () => {
    const write = vi.fn();
    vi.stubGlobal('ClipboardItem', undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });

    await expect(copyPngToClipboard(blob)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('downloadBlob', () => {
  it('saves under the given filename and releases the object URL', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const click = vi.fn();
    const anchor = originalCreateElement.call(document, 'a') as HTMLAnchorElement;
    anchor.click = click;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    downloadBlob(new Blob(['png'], { type: 'image/png' }), 'conquest-public-link.png');

    expect(anchor.download).toBe('conquest-public-link.png');
    expect(anchor.getAttribute('href')).toBe('blob:fake');
    expect(click).toHaveBeenCalledOnce();
    // Leaking the object URL would pin the blob in memory for the page's lifetime.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(anchor.isConnected).toBe(false);
  });
});
