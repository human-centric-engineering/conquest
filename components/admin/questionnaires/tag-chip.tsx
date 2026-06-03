/**
 * Tag chip presentation (F2.2).
 *
 * One source for how a tag renders — its colour swatch classes and the chip
 * element — shared by the read-only `VersionGraph` (server) and the interactive
 * editors (client). Purely presentational (no hooks / no `'use client'`), so both
 * tiers import it. Colours are the closed `TAG_COLORS` vocabulary mapped to literal
 * Tailwind classes (literal so the JIT keeps them); an absent/unknown colour falls
 * back to the neutral muted style.
 */

import { cn } from '@/lib/utils';
import type { TagColor } from '@/lib/app/questionnaire/types';
import type { TagView } from '@/lib/app/questionnaire/views';

const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  red: 'bg-red-100 text-red-700 border-red-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  green: 'bg-green-100 text-green-700 border-green-200',
  blue: 'bg-blue-100 text-blue-700 border-blue-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
  pink: 'bg-pink-100 text-pink-700 border-pink-200',
};

const TAG_NEUTRAL_CLASS = 'bg-muted text-muted-foreground border-transparent';

/** The chip classes for a tag colour (neutral when `null`/unknown). */
export function tagColorClass(color: TagColor | null): string {
  return color ? TAG_COLOR_CLASSES[color] : TAG_NEUTRAL_CLASS;
}

/** A small coloured pill for a tag label. */
export function TagChip({ tag, className }: { tag: TagView; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        tagColorClass(tag.color),
        className
      )}
    >
      {tag.label}
    </span>
  );
}
