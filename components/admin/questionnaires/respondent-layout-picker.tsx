'use client';

/**
 * RespondentLayoutPicker — choose how the respondent surface is arranged.
 *
 * A card per layout rather than a `<Select>`, because this is the one setting on the tab whose
 * value is a *shape*. "ConQuest Classic" and "Focus" in a dropdown tell an admin nothing about
 * what changes; a wireframe tells them immediately, and this setting is chosen most often by
 * someone preparing a demo who wants to see what the client will see.
 *
 * The thumbnails are deliberately abstract — grey blocks, no colour. The client's brand is a
 * separate axis (it lives on the demo client, not here), so tinting them would imply this control
 * governs colour, which it does not.
 *
 * Copy comes from `RESPONDENT_LAYOUT_META`, the same source the exported settings table reads, so
 * the picker and a client-facing PDF can never disagree about what a layout is called.
 */

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { RESPONDENT_LAYOUT_META } from '@/lib/app/questionnaire/layout/catalog';
import { RESPONDENT_LAYOUTS, type RespondentLayout } from '@/lib/app/questionnaire/types';

/** Conversation column beside a narrower answers track. */
function ClassicThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full gap-1 rounded-sm p-1.5">
      <div className="bg-background flex flex-[2] flex-col gap-1 rounded-[3px] border p-1">
        <span className="bg-muted-foreground/25 h-1 w-4/5 rounded-full" />
        <span className="bg-muted-foreground/40 ml-auto h-1 w-1/2 rounded-full" />
        <span className="bg-muted-foreground/25 h-1 w-3/5 rounded-full" />
        <span className="bg-muted-foreground/30 mt-auto h-1.5 w-full rounded-full" />
      </div>
      <div className="bg-background flex flex-1 flex-col gap-1 rounded-[3px] border p-1">
        <span className="bg-muted-foreground/20 h-1 w-full rounded-full" />
        <span className="bg-muted-foreground/20 h-1 w-2/3 rounded-full" />
      </div>
    </div>
  );
}

/** One centred column, nothing beside it. */
function FocusThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full justify-center rounded-sm p-1.5">
      <div className="bg-background flex w-3/5 flex-col gap-1 rounded-[3px] border p-1">
        <span className="bg-muted-foreground/25 h-1 w-4/5 rounded-full" />
        <span className="bg-muted-foreground/40 ml-auto h-1 w-1/2 rounded-full" />
        <span className="bg-muted-foreground/25 h-1 w-3/5 rounded-full" />
        <span className="bg-muted-foreground/30 mt-auto h-1.5 w-full rounded-full" />
      </div>
    </div>
  );
}

const THUMBS: Record<RespondentLayout, () => React.ReactElement> = {
  classic: ClassicThumb,
  focus: FocusThumb,
};

export interface RespondentLayoutPickerProps {
  value: RespondentLayout;
  onChange: (value: RespondentLayout) => void;
  disabled?: boolean;
}

export function RespondentLayoutPicker({
  value,
  onChange,
  disabled = false,
}: RespondentLayoutPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Respondent layout"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {RESPONDENT_LAYOUTS.map((key) => {
        const meta = RESPONDENT_LAYOUT_META[key];
        const Thumb = THUMBS[key];
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={cn(
              'group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              selected ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/40',
              disabled && 'pointer-events-none opacity-60'
            )}
          >
            {selected && (
              <span className="bg-primary text-primary-foreground absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full">
                <Check className="h-2.5 w-2.5" aria-hidden="true" />
              </span>
            )}
            <div className="h-14 w-full" aria-hidden="true">
              <Thumb />
            </div>
            <div className="space-y-0.5">
              <span className="block text-sm font-medium">{meta.label}</span>
              <span className="text-muted-foreground block text-xs leading-relaxed">
                {meta.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
