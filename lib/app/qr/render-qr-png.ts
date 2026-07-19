'use client';

/**
 * Rasterise a ConQuest QR code to a PNG blob, for download and for clipboard copy.
 *
 * Browser-only: it draws through a detached `<canvas>`, so it must not be pulled into
 * a server component. Display uses inline SVG instead (see `LinkQrCode`) — this path
 * exists because neither "Save image" nor an image-flavoured clipboard write can be
 * fed vector markup that a phone camera, a print shop, or Slack will accept.
 *
 * The exported bitmap is deliberately large (1024px default): QR codes are routinely
 * reprinted on posters and slides, and upscaling a screen-sized capture is what makes
 * them stop scanning.
 */

import {
  createQrMatrix,
  qrLogoMarkRect,
  qrLogoRect,
  qrPathData,
  type QrCodeMatrix,
} from '@/lib/app/qr/qr-matrix';

/** The CQ mark drawn at the centre — the favicon source, at a size that stays crisp when scaled. */
export const QR_LOGO_SRC = '/android-chrome-192x192.png';

export interface RenderQrPngOptions {
  /** Width and height of the output PNG, in pixels. */
  pixelSize?: number;
  /** Override the centred mark. Must be same-origin, or the canvas taints and export fails. */
  logoSrc?: string;
}

/** Load an image and resolve once it has decoded, so canvas draws never race it. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load QR logo: ${src}`));
    img.src = src;
  });
}

/** Draw the white plate plus the CQ mark over the centre of an already-drawn symbol. */
function drawLogo(
  ctx: CanvasRenderingContext2D,
  matrix: QrCodeMatrix,
  logo: HTMLImageElement,
  scale: number
): void {
  const plate = qrLogoRect(matrix);
  const mark = qrLogoMarkRect(matrix);

  // The plate is what actually guarantees the mark reads as separate from the symbol;
  // without it the dark navy favicon would blend into surrounding dark modules.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(
    plate.x * scale,
    plate.y * scale,
    plate.side * scale,
    plate.side * scale,
    plate.radius * scale
  );
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(
    mark.x * scale,
    mark.y * scale,
    mark.side * scale,
    mark.side * scale,
    mark.radius * scale
  );
  ctx.clip();
  ctx.drawImage(logo, mark.x * scale, mark.y * scale, mark.side * scale, mark.side * scale);
  ctx.restore();
}

/**
 * Encode `text` as a QR code and rasterise it to a PNG blob.
 *
 * @throws if the text can't be encoded, the logo fails to load, or the canvas
 *   refuses to produce a blob.
 */
export async function renderQrPngBlob(
  text: string,
  { pixelSize = 1024, logoSrc = QR_LOGO_SRC }: RenderQrPngOptions = {}
): Promise<Blob> {
  const matrix = createQrMatrix(text);

  const canvas = document.createElement('canvas');
  canvas.width = pixelSize;
  canvas.height = pixelSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderQrPngBlob: 2D canvas context unavailable');

  // Always light-on-dark-modules regardless of the app theme — scanners expect
  // dark modules on a light field, and a "dark mode" QR is a broken QR.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pixelSize, pixelSize);

  const scale = pixelSize / matrix.span;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = '#000000';
  ctx.fill(new Path2D(qrPathData(matrix)));
  ctx.restore();

  drawLogo(ctx, matrix, await loadImage(logoSrc), scale);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('renderQrPngBlob: canvas produced no blob'));
    }, 'image/png');
  });
}

/** Whether this browser can put an image on the clipboard. */
export function canCopyImages(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  );
}

/**
 * Write a PNG blob to the clipboard. Resolves `false` when the browser lacks support
 * or the user denies permission — copying is best-effort, and download is the fallback.
 */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  if (!canCopyImages()) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

/** Trigger a browser download of `blob` as `fileName`, cleaning up the object URL after. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
