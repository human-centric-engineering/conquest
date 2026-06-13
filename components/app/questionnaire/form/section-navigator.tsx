'use client';

/**
 * SectionNavigator — the completeness map for the raw form surface (P-presentation).
 *
 * Lists the questionnaire's sections with a per-section answered/total count and a row
 * of per-question dots: filled when answered, hollow when pending, and ringed when the
 * answer was INFERRED by the agent (provenance inferred/synthesised) so the respondent
 * can see — and choose to adjust — what the conversation filled in the background. Click
 * a section to jump to it; the active section is highlighted.
 */

import { cn } from '@/lib/utils';
import type { PanelSectionView } from '@/lib/app/questionnaire/panel/types';

export interface SectionNavigatorProps {
  sections: PanelSectionView[];
  activeIndex: number;
  onJump: (index: number) => void;
  /** Whether a slot currently counts as answered (local edits included). */
  isAnswered: (slotKey: string) => boolean;
  /** Whether a slot's current answer was inferred by the agent (vs respondent-stated). */
  isInferred: (slotKey: string) => boolean;
  className?: string;
}

export function SectionNavigator({
  sections,
  activeIndex,
  onJump,
  isAnswered,
  isInferred,
  className,
}: SectionNavigatorProps) {
  return (
    <nav className={cn('space-y-1.5', className)} aria-label="Sections">
      {sections.map((section, index) => {
        const total = section.slots.length;
        const answered = section.slots.filter((s) => isAnswered(s.slotKey)).length;
        const active = index === activeIndex;
        const complete = total > 0 && answered === total;
        return (
          <button
            key={section.sectionId}
            type="button"
            onClick={() => onJump(index)}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left transition-colors',
              active ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted'
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground truncate text-sm font-medium">
                {section.title || `Section ${index + 1}`}
              </span>
              <span
                className={cn(
                  'shrink-0 text-xs tabular-nums',
                  complete ? 'text-primary font-medium' : 'text-muted-foreground'
                )}
              >
                {answered}/{total}
              </span>
            </div>
            {total > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1" aria-hidden="true">
                {section.slots.map((slot) => {
                  const ans = isAnswered(slot.slotKey);
                  const inferred = ans && isInferred(slot.slotKey);
                  return (
                    <span
                      key={slot.slotKey}
                      title={slot.prompt}
                      className={cn(
                        'h-2 w-2 rounded-full',
                        !ans && 'border-muted-foreground/40 border border-dashed',
                        ans && inferred && 'bg-primary/40 ring-primary ring-1',
                        ans && !inferred && 'bg-primary'
                      )}
                    />
                  );
                })}
              </div>
            )}
          </button>
        );
      })}
    </nav>
  );
}
