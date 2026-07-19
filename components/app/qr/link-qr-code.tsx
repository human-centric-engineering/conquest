'use client';

/**
 * LinkQrCode — a scannable QR for a shareable ConQuest URL, with the CQ mark at its
 * centre, plus "Download PNG" and "Copy image" actions.
 *
 * Display is inline SVG (crisp at any zoom, no canvas needed to paint it); the two
 * actions rasterise on demand via `renderQrPngBlob`, because a file save and an
 * image-flavoured clipboard write both need a bitmap. Both derive from the same
 * matrix as the SVG, so what you scan is what you download.
 *
 * The code is always dark-on-white regardless of the app theme — scanners expect that
 * polarity, so the surrounding card is explicitly light in dark mode too.
 */

import { Check, Copy, Download } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  createQrMatrix,
  qrDisplaySize,
  qrFileStem,
  qrLogoMarkRect,
  qrLogoRect,
  qrPathData,
} from '@/lib/app/qr/qr-matrix';
import {
  QR_LOGO_SRC,
  canCopyImages,
  copyPngToClipboard,
  downloadBlob,
  renderQrPngBlob,
} from '@/lib/app/qr/render-qr-png';
import { logger } from '@/lib/logging';

export interface LinkQrCodeProps {
  /** Absolute URL the QR should encode. */
  url: string;
  /**
   * Human label for the link, used to name the downloaded file
   * (e.g. `Public link` → `conquest-public-link.png`).
   */
  label?: string;
  /**
   * Preferred on-screen width in pixels. Treated as a floor: a dense symbol (a long invite
   * URL) is rendered larger so its modules stay big enough to scan.
   */
  displaySize?: number;
  className?: string;
}

export function LinkQrCode({ url, label, displaySize = 176, className }: LinkQrCodeProps) {
  const clipId = useId();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probed after mount, never during render: `ClipboardItem` doesn't exist on the server,
  // so branching on it inline would render a different button set than it hydrates into.
  const [canCopy, setCanCopy] = useState(false);
  useEffect(() => setCanCopy(canCopyImages()), []);

  // Clear the "Copied" reset on unmount so it can't fire setState afterwards (issue #301).
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  // Encoding is pure and cheap, but re-running it on every parent render would churn a
  // few thousand array writes per keystroke on surfaces that live inside a form.
  const drawing = useMemo(() => {
    try {
      const matrix = createQrMatrix(url);
      return {
        matrix,
        path: qrPathData(matrix),
        plate: qrLogoRect(matrix),
        mark: qrLogoMarkRect(matrix),
      };
    } catch {
      // Only unencodable input (empty, or beyond QR capacity at level H) lands here.
      return null;
    }
  }, [url]);

  const fileName = `conquest-${qrFileStem(label)}.png`;

  const withPng = useCallback(
    async (action: (blob: Blob) => void | Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action(await renderQrPngBlob(url));
      } catch (err) {
        // Never log `url`: on invite surfaces it carries a live single-use token, and the
        // logger redacts by key name (`token`, `secret`, …), not by value — a full URL
        // under the key `url` would be emitted verbatim.
        logger.error('Failed to render QR PNG', { error: err, urlLength: url.length });
        setError('Could not generate the image. Copy the link instead.');
      } finally {
        setBusy(false);
      }
    },
    [url]
  );

  const handleDownload = useCallback(
    () => void withPng((blob) => downloadBlob(blob, fileName)),
    [withPng, fileName]
  );

  const handleCopyImage = useCallback(
    () =>
      void withPng(async (blob) => {
        if (await copyPngToClipboard(blob)) {
          setCopied(true);
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setCopied(false), 2000);
        } else {
          // Clipboard images are unsupported or were denied — fall back to a download
          // so the action still leaves the user holding the image.
          downloadBlob(blob, fileName);
        }
      }),
    [withPng, fileName]
  );

  if (!drawing) return null;

  const { matrix, path, plate, mark } = drawing;
  const renderedSize = qrDisplaySize(matrix.span, displaySize);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="rounded-lg border bg-white p-2 shadow-sm">
          <svg
            width={renderedSize}
            height={renderedSize}
            className="h-auto max-w-full"
            viewBox={`0 0 ${matrix.span} ${matrix.span}`}
            role="img"
            aria-label={`QR code for ${label ?? 'this link'}`}
            shapeRendering="crispEdges"
          >
            <rect width={matrix.span} height={matrix.span} fill="#ffffff" />
            <path d={path} fill="#000000" />
            {/* White plate keeps the navy CQ mark from blending into dark modules. */}
            <rect
              x={plate.x}
              y={plate.y}
              width={plate.side}
              height={plate.side}
              rx={plate.radius}
              fill="#ffffff"
            />
            <clipPath id={clipId}>
              <rect x={mark.x} y={mark.y} width={mark.side} height={mark.side} rx={mark.radius} />
            </clipPath>
            <image
              href={QR_LOGO_SRC}
              x={mark.x}
              y={mark.y}
              width={mark.side}
              height={mark.side}
              clipPath={`url(#${clipId})`}
              preserveAspectRatio="xMidYMid slice"
            />
          </svg>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={busy}
          >
            <Download className="mr-1.5 h-3 w-3" />
            Download PNG
          </Button>
          {canCopy && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyImage}
              disabled={busy}
            >
              {copied ? (
                <Check className="mr-1.5 h-3 w-3 text-emerald-600" />
              ) : (
                <Copy className="mr-1.5 h-3 w-3" />
              )}
              {copied ? 'Copied' : 'Copy image'}
            </Button>
          )}
          <p className="text-muted-foreground max-w-[16rem] text-xs">
            Scan with a phone camera to open the link.
          </p>
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
      </div>
    </div>
  );
}
