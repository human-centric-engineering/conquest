'use client';

/**
 * SessionRefChip — the respondent-facing support reference ("Ref: 7F3K-9M2P").
 *
 * A quiet, always-available chip the respondent can quote when reporting a bad experience. Shows
 * the grouped reference with an ⓘ tooltip explaining what it's for, and copies the code to the
 * clipboard on click (the most common thing a frustrated user wants to do with it). Used on the
 * lifecycle strip during the session and on the completion screen.
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';

export interface SessionRefChipProps {
  /** The raw `publicRef` (8-char, no dash); displayed grouped. */
  refRaw: string;
  className?: string;
}

const TOOLTIP = 'Quote this reference if you need to report a problem with this conversation.';

export function SessionRefChip({ refRaw, className }: SessionRefChipProps) {
  const [copied, setCopied] = useState(false);
  const display = formatSessionRef(refRaw);

  async function copy() {
    try {
      await navigator.clipboard.writeText(display);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the code is still visible to read aloud.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={TOOLTIP}
      aria-label={`Support reference ${display}. ${TOOLTIP} Click to copy.`}
      className={cn(
        'hover:text-foreground inline-flex items-center gap-1.5 rounded font-mono text-xs tracking-wide transition-colors',
        className
      )}
    >
      <span className="text-muted-foreground">Ref:</span>
      <span className="font-semibold">{display}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3 opacity-60" aria-hidden="true" />
      )}
    </button>
  );
}
