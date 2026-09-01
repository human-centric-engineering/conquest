'use client';

/**
 * Sectioned interviews (P21) — the strip of sections the respondent moves between.
 *
 * Renders nothing when the interview is not sectioned, which is most of them, so every layout can
 * place it unconditionally.
 *
 * Two variants, chosen by the host layout rather than by width:
 *
 *  - `strip` — the full horizontal tab list. Classic and Broadsheet.
 *  - `menu` — a compact "Part 2 of 5" button opening the same list in a popover. Focus (whose whole
 *    argument is stripped chrome) and Horizon (which folds accumulated context away).
 *
 * The list scrolls inside its own `overflow-x` container: a twelve-section instrument must never
 * widen the shell, which is aligned to the site header and footer and must stay so.
 */

import { Check, ChevronDown, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { SectionStripView, SectionTabView } from '@/lib/app/questionnaire/sections/view';

export interface SectionTabStripProps {
  view: SectionStripView;
  /** Called with the section key when the respondent picks one. */
  onSelect: (key: string) => void;
  /** False while a turn is in flight — moving mid-stream would strand the reply. */
  canSelect: boolean;
  variant?: 'strip' | 'menu';
  className?: string;
}

/** The tabs a given view actually draws: locked ones are hidden when the version says so. */
function visibleTabs(view: SectionStripView): SectionTabView[] {
  return view.showLocked ? view.sections : view.sections.filter((tab) => tab.isAvailable);
}

function TabButton({
  tab,
  total,
  onSelect,
  canSelect,
  block,
}: {
  tab: SectionTabView;
  total: number;
  onSelect: (key: string) => void;
  canSelect: boolean;
  block?: boolean;
}) {
  const disabled = !canSelect || !tab.isAvailable;
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.key)}
      disabled={disabled}
      // `aria-current` rather than a visual-only active state: on the menu variant the strip is not
      // on screen, so the active section has to be announced rather than merely tinted.
      aria-current={tab.isActive ? 'step' : undefined}
      className={cn(
        'group/tab flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
        block && 'w-full justify-start',
        tab.isActive
          ? 'border-transparent bg-[var(--app-accent-color,var(--primary))] text-white'
          : 'border-border text-muted-foreground hover:text-foreground',
        disabled && !tab.isActive && 'hover:text-muted-foreground cursor-not-allowed opacity-50'
      )}
    >
      {tab.status === 'closed' ? (
        <Check className="size-3.5 shrink-0" aria-hidden />
      ) : !tab.isAvailable ? (
        <Lock className="size-3 shrink-0" aria-hidden />
      ) : null}
      <span className="truncate">{tab.label}</span>
      <span className="sr-only">
        {` (part ${tab.position} of ${total}`}
        {tab.status === 'closed' ? ', finished' : !tab.isAvailable ? ', not available yet' : ''}
        {')'}
      </span>
    </button>
  );
}

export function SectionTabStrip({
  view,
  onSelect,
  canSelect,
  variant = 'strip',
  className,
}: SectionTabStripProps) {
  if (!view.active) return null;
  const tabs = visibleTabs(view);
  if (tabs.length === 0) return null;

  const active = view.sections.find((tab) => tab.isActive);

  if (variant === 'menu') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className={cn('gap-1.5 text-xs', className)}>
            <span className="max-w-[12rem] truncate">{active ? active.label : 'Sections'}</span>
            <span className="text-muted-foreground">
              {active ? `${active.position}/${view.sections.length}` : ''}
            </span>
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2">
          <div className="flex flex-col gap-1" role="group" aria-label="Sections">
            {tabs.map((tab) => (
              <TabButton
                key={tab.key}
                tab={tab}
                total={view.sections.length}
                onSelect={onSelect}
                canSelect={canSelect}
                block
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <nav
      aria-label="Sections"
      // Its own scroll container, never the page's. The shell width is aligned to the site header
      // and footer, and a long section list must not be the thing that breaks that alignment.
      className={cn('flex gap-2 overflow-x-auto pb-1', className)}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.key}
          tab={tab}
          total={view.sections.length}
          onSelect={onSelect}
          canSelect={canSelect}
        />
      ))}
    </nav>
  );
}
