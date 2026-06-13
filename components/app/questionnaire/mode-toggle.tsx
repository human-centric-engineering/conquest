'use client';

/**
 * ModeToggle — the compact chat ↔ form switch for "both" presentation mode (P-presentation).
 *
 * A small segmented pill with a sliding accent indicator, sized to sit inline on the session
 * lifecycle strip (no dedicated row). The slide telegraphs the carousel transition the
 * workspace runs between the two surfaces; it's always visible so the respondent knows the
 * form escape-hatch is one tap away. Honours `prefers-reduced-motion`.
 */

import { MessageSquare, ListChecks } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SessionView = 'chat' | 'form';

const ITEMS: { id: SessionView; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'form', label: 'Form', Icon: ListChecks },
];

export interface ModeToggleProps {
  value: SessionView;
  onChange: (view: SessionView) => void;
  className?: string;
}

export function ModeToggle({ value, onChange, className }: ModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="How to answer"
      className={cn(
        'bg-muted/70 relative inline-grid grid-cols-2 rounded-full border p-1 backdrop-blur',
        className
      )}
    >
      {/* Sliding accent indicator. p-1 = 4px, so width 50%-4px starting at left-1 lands exactly
          under each segment when translated by its own width. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none',
          value === 'form' && 'translate-x-full'
        )}
        style={{ backgroundColor: 'var(--app-cta-color, var(--cq-accent, var(--color-primary)))' }}
      />
      {ITEMS.map(({ id, label, Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              active ? 'text-white' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
