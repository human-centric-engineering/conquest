'use client';

/**
 * CopyLinkField — a read-only URL shown alongside a copy-to-clipboard button. The
 * single "here is a shareable link" affordance reused by the collective public link
 * (Invitations page + Settings tab) and the per-invitee reveal dialog.
 *
 * Read-only by design: it displays a URL the caller already holds — it never fetches
 * or mints anything.
 */

import { Check, Copy } from 'lucide-react';

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
}

export function CopyLinkField({ url, label, note }: CopyLinkFieldProps) {
  // Clipboard can be denied (permissions / insecure context); the hook swallows that and the
  // input is selectable as a manual fallback, so a failed copy needs no error surface.
  const { copied, copy } = useCopyToClipboard();

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
      </div>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </div>
  );
}
