'use client';

/**
 * ModeToggle — the compact segmented switch for the workspace's surfaces (P-presentation).
 *
 * A small segmented pill with a sliding accent indicator, sized to sit inline on the session
 * lifecycle strip (no dedicated row). The slide telegraphs the carousel transition the workspace
 * runs between surfaces; it's always visible so the respondent knows every surface — the form
 * escape-hatch, and (when present) the Intro recap — is one tap away. Honours
 * `prefers-reduced-motion`.
 *
 * Generic over its `items`: two segments for plain chat ↔ form, more when an Intro recap and/or the
 * "Choose your interviewer" persona picker ride alongside. The indicator width and offset are
 * computed from the item count, so any N-segment set lands pixel-aligned without bespoke classes.
 */

import { MessageSquare, ListChecks, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SessionView = 'chat' | 'form';

export interface ToggleItem {
  /** Stable id reported to `onChange` and matched against `value`. */
  id: string;
  label: string;
  Icon: LucideIcon;
}

const DEFAULT_ITEMS: ToggleItem[] = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'form', label: 'Form', Icon: ListChecks },
];

export interface ModeToggleProps {
  value: string;
  onChange: (view: string) => void;
  /** The segments, left→right. Defaults to chat ↔ form. */
  items?: ToggleItem[];
  className?: string;
}

export function ModeToggle({ value, onChange, items = DEFAULT_ITEMS, className }: ModeToggleProps) {
  const count = items.length;
  // Clamp so an unknown value parks the indicator under the first segment rather than off-track.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value)
  );

  return (
    <div
      role="tablist"
      aria-label="How to answer"
      className={cn(
        'bg-muted/70 relative inline-grid rounded-full border p-1 backdrop-blur',
        className
      )}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {/* Sliding accent indicator. p-1 = 4px each side (0.5rem total), so a segment is
          (100% - 0.5rem)/count wide; translating by its own width per index lands it exactly
          under each segment from the left-1 origin. (count=2 → the legacy 50%-4px geometry.) */}
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-1 rounded-full shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.5rem) / ${count})`,
          transform: `translateX(${activeIndex * 100}%)`,
          background:
            'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))',
        }}
      />
      {items.map(({ id, label, Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            onClick={() => onChange(id)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors sm:px-3',
              active ? 'text-white' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/* Icon + word at every normal width. Only on EXTREMELY small screens (≤360px) does the
                word drop to icon-only, so a crowded 4-segment strip can't overflow. `aria-label`
                keeps each tab named when the word is hidden. */}
            <span className="max-[360px]:hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
