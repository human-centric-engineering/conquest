'use client';

/**
 * CopyLinkField — a read-only URL shown alongside a copy-to-clipboard button. The
 * single "here is a shareable link" affordance reused by the collective public link
 * (Invitations page + Settings tab) and the per-invitee reveal dialog.
 *
 * Read-only by design: it displays a URL the caller already holds — it never fetches
 * or mints anything.
 *
 * With `showQr`, it also offers a scannable QR for the same URL behind a toggle. The
 * QR is collapsed by default because most admins are pasting the link into an email,
 * not holding a phone up to the screen — and an always-on 176px block would push the
 * surrounding form around for the majority who don't need it.
 */

import { Check, Copy, QrCode } from 'lucide-react';
import { useState } from 'react';

import { LinkQrCode } from '@/components/app/qr/link-qr-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';

export interface CopyLinkFieldProps {
  /** Absolute URL to display and copy. */
  url: string;
  /** Optional field label rendered above the input. */
  label?: string;
  /** Optional muted helper line rendered below the input. */
  note?: string;
  /** Offer a "Show QR code" toggle revealing a scannable, downloadable code for `url`. */
  showQr?: boolean;
  /**
   * Names the downloaded QR file and its accessible label. Defaults to `label` — pass this
   * when the surrounding UI (a dialog title, say) already names the link and rendering a
   * visible `label` would just repeat it.
   */
  qrLabel?: string;
}

export function CopyLinkField({ url, label, note, showQr = false, qrLabel }: CopyLinkFieldProps) {
  // Clipboard can be denied (permissions / insecure context); the hook swallows that and the
  // input is selectable as a manual fallback, so a failed copy needs no error surface.
  const { copied, copy } = useCopyToClipboard();
  const [qrOpen, setQrOpen] = useState(false);

  return (
    <div className="space-y-1.5">
      {label && <Label className="text-sm font-medium">{label}</Label>}
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
          aria-label={label ?? 'Shareable link'}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copy(url)}
          className="shrink-0"
        >
          {copied ? (
            <Check className="mr-1.5 h-3 w-3 text-emerald-600" />
          ) : (
            <Copy className="mr-1.5 h-3 w-3" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {showQr && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setQrOpen((open) => !open)}
            aria-expanded={qrOpen}
            className="shrink-0"
          >
            <QrCode className="mr-1.5 h-3 w-3" />
            {qrOpen ? 'Hide QR' : 'QR code'}
          </Button>
        )}
      </div>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      {showQr && qrOpen && <LinkQrCode url={url} label={qrLabel ?? label} className="pt-2" />}
    </div>
  );
}
