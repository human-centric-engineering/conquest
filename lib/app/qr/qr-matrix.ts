/**
 * QR matrix helpers — a thin, framework-free wrapper over the `qrcode` encoder.
 *
 * The encoder gives us a bitmap of dark/light modules; everything ConQuest draws
 * (inline SVG for display, canvas for PNG export) is derived from that one matrix
 * so the on-screen code and the downloaded file are guaranteed identical.
 *
 * Error correction is pinned to `H` (~30% recoverable) because every ConQuest QR
 * carries the CQ mark over its centre. The mark occupies `QR_LOGO_RATIO`² of the
 * symbol area (~5%), well inside that budget — the redundancy is what makes
 * covering the middle safe rather than merely lucky.
 *
 * Geometry is expressed in *module units*, not pixels: callers pick a pixel size
 * and scale. That keeps this module resolution-independent and testable.
 */

import QRCode from 'qrcode';

/** Light margin around the symbol, in modules. 4 is the QR spec's minimum quiet zone. */
export const QR_QUIET_ZONE = 4;

/** Side length of the centred logo plate as a fraction of the full drawing (incl. quiet zone). */
export const QR_LOGO_RATIO = 0.24;

/** Corner radius of the logo plate, as a fraction of the plate's side. */
export const QR_LOGO_RADIUS_RATIO = 0.22;

/** Padding between the plate's edge and the mark drawn on it, as a fraction of the plate. */
export const QR_LOGO_INSET_RATIO = 0.12;

/** The mark's corner radius relative to the plate's, keeping the inner curve concentric. */
export const QR_LOGO_MARK_RADIUS_FACTOR = 0.8;

export interface QrCodeMatrix {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** Row-major dark-module flags, `size * size` entries long. */
  dark: boolean[];
  /** Modules per side including the quiet zone on both edges — the drawing's coordinate span. */
  span: number;
}

/**
 * Encode `text` into a QR module matrix.
 *
 * @throws if `text` is empty or too long to encode at error-correction level H.
 */
export function createQrMatrix(text: string): QrCodeMatrix {
  if (!text) throw new Error('createQrMatrix: text must be a non-empty string');

  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const { size, data } = modules;

  const dark = new Array<boolean>(size * size);
  for (let i = 0; i < data.length; i += 1) dark[i] = data[i] === 1;

  return { size, dark, span: size + QR_QUIET_ZONE * 2 };
}

/** Whether the module at (`row`, `col`) is dark. Out-of-range coordinates read as light. */
export function isDarkModule(matrix: QrCodeMatrix, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return false;
  return matrix.dark[row * matrix.size + col];
}

/**
 * Build a single SVG path covering every dark module, in module units offset by the
 * quiet zone.
 *
 * One path beats one `<rect>` per module by a wide margin: a version-10 code is ~3,600
 * modules, and emitting that many elements bloats the DOM and the exported markup for
 * no visual gain. Horizontally adjacent modules are merged into a single run, which
 * roughly halves the command count again.
 */
export function qrPathData(matrix: QrCodeMatrix): string {
  const parts: string[] = [];

  for (let row = 0; row < matrix.size; row += 1) {
    let runStart = -1;

    for (let col = 0; col <= matrix.size; col += 1) {
      // The extra `col === size` iteration flushes a run that reaches the right edge.
      const dark = col < matrix.size && isDarkModule(matrix, row, col);

      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        const x = runStart + QR_QUIET_ZONE;
        const y = row + QR_QUIET_ZONE;
        parts.push(`M${x} ${y}h${col - runStart}v1h-${col - runStart}z`);
        runStart = -1;
      }
    }
  }

  return parts.join('');
}

/**
 * Geometry of the centred logo plate, in the same module units as {@link qrPathData}.
 */
export function qrLogoRect(matrix: QrCodeMatrix): {
  x: number;
  y: number;
  side: number;
  radius: number;
} {
  const side = matrix.span * QR_LOGO_RATIO;
  const offset = (matrix.span - side) / 2;
  return { x: offset, y: offset, side, radius: side * QR_LOGO_RADIUS_RATIO };
}

/**
 * Geometry of the CQ mark drawn inside the plate, inset so the white border survives.
 *
 * Both renderers (inline SVG for display, canvas for PNG export) derive the mark from this
 * one function. They previously each hardcoded the inset and radius factor, which let the
 * on-screen code and the downloaded file drift apart — the opposite of the guarantee this
 * feature makes.
 */
export function qrLogoMarkRect(matrix: QrCodeMatrix): {
  x: number;
  y: number;
  side: number;
  radius: number;
} {
  const plate = qrLogoRect(matrix);
  const inset = plate.side * QR_LOGO_INSET_RATIO;
  return {
    x: plate.x + inset,
    y: plate.y + inset,
    side: plate.side - inset * 2,
    radius: plate.radius * QR_LOGO_MARK_RADIUS_FACTOR,
  };
}

/**
 * On-screen pixels per module needed for a phone camera to read the code reliably.
 *
 * A decoder fed a clean screenshot copes with ~2.5, but a real scan is handheld, angled,
 * and often glare-lit; 4 leaves headroom for that. This is the constant that stops a long
 * invite URL (more modules in the same box) from silently becoming unscannable.
 */
const MIN_PX_PER_MODULE = 4;

/** Upper bound on the rendered code, so a dense symbol can't dominate the surrounding form. */
const MAX_DISPLAY_PX = 320;

/**
 * Pick a render size for `span` modules: at least `preferred`, but grown toward
 * {@link MAX_DISPLAY_PX} when the symbol is dense enough that `preferred` would squeeze
 * modules below the legible threshold.
 */
export function qrDisplaySize(span: number, preferred: number): number {
  return Math.min(MAX_DISPLAY_PX, Math.max(preferred, Math.ceil(span * MIN_PX_PER_MODULE)));
}

/**
 * Slugify `label` into a safe download filename stem, e.g. `Public link` → `public-link`.
 * Falls back to `qr-code` when nothing usable survives.
 *
 * Unicode letters and digits are kept, not stripped. An ASCII-only allowlist collapsed every
 * non-Latin name to the same stem — a cohort of `invite-李伟`, `invite-陈静`, … all downloaded
 * as `conquest-invite.png` and silently overwrote each other. Filenames are Unicode-safe on
 * every platform we target; what actually has to go is path separators, dots, and control
 * characters, and those are neither letters nor digits, so they still collapse to `-`.
 */
export function qrFileStem(label: string | undefined): string {
  const slug = (label ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'qr-code';
}
