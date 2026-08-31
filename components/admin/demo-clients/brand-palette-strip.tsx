'use client';

/**
 * DEMO-ONLY (brand import): the colours an import measured, shown on the branding page.
 *
 * The import dialog has always rendered this list — "Every colour we measured" — and then thrown it
 * away when the dialog closed. That made the evidence the most fragile part of the feature and the
 * proposals the most durable, which is backwards: a proposal can be re-typed from a brand
 * guideline, while a colour measured off a site that has since been redesigned cannot be measured
 * again. So the palette is persisted (`AppDemoClient.brandPalette`) and rendered here, beside the
 * fields it produced.
 *
 * ## Two readings of one palette
 *
 * A proportional band FIRST, then the chips. The band answers "what is this brand?" at a glance —
 * a navy-and-gold company and a pastel one look different from across the room, and a uniform grid
 * of equal chips flattens that difference away. The chips answer "what is that colour, exactly?",
 * which is the question an admin filling in a field by hand actually has.
 *
 * ## Click to copy, not click to apply
 *
 * A chip copies its hex. It deliberately does NOT write itself into a field: the strip has ten
 * colours and the form has ten colour boxes, so "apply" would need a target, and every way of
 * choosing one (the last-focused field, a dropdown per chip) is more machinery than pasting. The
 * import dialog is where colours are ASSIGNED to roles; this is the reference sheet beside it.
 */

import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import type { BrandPalette } from '@/lib/app/questionnaire/brand-import/palette-record';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The smallest slice of the band we will draw, as a percentage.
 *
 * A colour with a 0.2% share is still worth showing — brand accents are small by nature, and the
 * accent is often the single most useful hex in the list — but at its true width it is a sub-pixel
 * sliver nobody can see or point at. The floor makes it visible; the chip below carries the honest
 * number.
 */
const MIN_BAND_PERCENT = 2;

export interface BrandPaletteStripProps {
  palette: BrandPalette;
  /** Drop the stored palette (marks the form dirty; the save clears the column). */
  onClear?: () => void;
  disabled?: boolean;
}

export function BrandPaletteStrip({ palette, onClear, disabled }: BrandPaletteStripProps) {
  const { copied, copy } = useCopyToClipboard();
  // Which chip the hook's 2-second window belongs to. The hook owns the timer (and its unmount
  // cleanup); this only remembers where to draw the tick, so there is no second timer to leak.
  const [copiedHex, setCopiedHex] = useState<string | null>(null);

  const handleCopy = async (hex: string) => {
    setCopiedHex(hex);
    if (!(await copy(hex))) setCopiedHex(null);
  };

  const total = palette.candidates.reduce((sum, c) => sum + c.share, 0);

  return (
    <div className="space-y-3 rounded-md border px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-1 text-sm font-medium">
          Colours we read
          <FieldHelp title="The measured palette">
            Every colour a brand import measured on the client&apos;s own site, ranked by how much
            of the page it covers. Kept as the evidence behind the fields above — click any swatch
            to copy its hex when you want to set a field by hand. These are a record of what was
            there on the day we looked; they are never applied to the questionnaire by themselves.
          </FieldHelp>
        </p>
        <p className="text-muted-foreground text-xs">
          {palette.readFrom ? `${palette.readFrom} · ` : ''}
          {formatDate(palette.capturedAt)}
        </p>
      </div>

      {/* The band. `aria-hidden` because it is a second rendering of the chips below, which are
          the accessible list — a screen reader announcing both would read the palette twice. */}
      <div
        className="flex h-8 w-full overflow-hidden rounded border"
        aria-hidden
        data-testid="brand-palette-band"
      >
        {palette.candidates.map((candidate) => (
          <span
            key={candidate.hex}
            className="h-full"
            style={{
              backgroundColor: candidate.hex,
              // Normalised against the measured total rather than assumed to sum to 1: the
              // candidates are the TOP colours, so a page with a long tail of one-off pixels
              // leaves a gap the band would otherwise render as a hole.
              flexGrow: Math.max(total > 0 ? (candidate.share / total) * 100 : 1, MIN_BAND_PERCENT),
              flexBasis: 0,
            }}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-2">
        {palette.candidates.map((candidate) => {
          const isCopied = copied && copiedHex === candidate.hex;
          return (
            <li key={candidate.hex}>
              <button
                type="button"
                onClick={() => void handleCopy(candidate.hex)}
                className="hover:bg-muted focus-visible:ring-ring flex items-center gap-1.5 rounded-md border px-2 py-1 focus-visible:ring-2 focus-visible:outline-none"
                // The share and the neutral flag ride in the accessible name rather than in a
                // `title`: they are the reason to prefer one candidate over another for a given
                // field, and a tooltip is not readable by keyboard or screen reader.
                aria-label={`Copy ${candidate.hex} — ${(candidate.share * 100).toFixed(1)} percent of the page${
                  candidate.neutral ? ', a neutral' : ''
                }`}
              >
                <span
                  className="h-4 w-4 rounded-sm border"
                  style={{ backgroundColor: candidate.hex }}
                  aria-hidden
                />
                <code className="text-xs">{candidate.hex}</code>
                <span className="text-muted-foreground text-[0.65rem] tabular-nums">
                  {(candidate.share * 100).toFixed(1)}%
                </span>
                {isCopied ? (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
                ) : (
                  <Copy className="text-muted-foreground h-3 w-3" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {onClear && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            Re-running the import replaces these. Clearing them leaves the colours above untouched.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn('h-7 shrink-0 px-2 text-xs')}
            disabled={disabled}
            onClick={onClear}
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
