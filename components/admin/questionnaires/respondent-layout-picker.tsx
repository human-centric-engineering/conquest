'use client';

/**
 * RespondentLayoutPicker — choose how the respondent surface is arranged.
 *
 * A card per layout rather than a `<Select>`, because this is the one setting on the tab whose
 * value is a *shape*. "ConQuest Classic", "Focus", "Broadsheet" and "Horizon" in a dropdown tell an
 * admin nothing about what changes; a wireframe tells them immediately, and this setting is chosen
 * most often by someone preparing a demo who wants to see what the client will see.
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

/**
 * A wide document with the answer box held in the margin beside it.
 *
 * The rail is drawn as a filled block rather than lines: it is the one part of this wireframe that
 * is a control rather than text, and an admin comparing three grey thumbnails needs the difference
 * from Classic — whose right-hand track is *also* a bordered column — to be legible at 56px.
 */
function BroadsheetThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full gap-1 rounded-sm p-1.5">
      <div className="bg-background flex flex-[3] flex-col gap-1 rounded-[3px] border p-1">
        <span className="bg-muted-foreground/25 h-1 w-full rounded-full" />
        <span className="bg-muted-foreground/40 ml-auto h-1 w-1/2 rounded-full" />
        <span className="bg-muted-foreground/25 h-1 w-5/6 rounded-full" />
        <span className="bg-muted-foreground/25 h-1 w-2/3 rounded-full" />
      </div>
      <div className="flex flex-1 flex-col rounded-[3px]">
        <span className="bg-muted-foreground/30 h-3.5 w-full rounded-[3px]" />
      </div>
    </div>
  );
}

/**
 * One question on a stage, with the rest of the conversation folded into a strip above it.
 *
 * The folded strip is the whole difference from Focus — which is otherwise also a single column —
 * so it is drawn as one flat bar hard against the top edge, and the question below it is given
 * fewer, longer lines with air around them. At 56px that reads as "less on screen", which is the
 * decision the admin is actually making.
 */
function HorizonThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full justify-center rounded-sm p-1.5">
      <div className="bg-background flex w-3/5 flex-col gap-1 rounded-[3px] border p-1">
        {/* The folded history. */}
        <span className="bg-muted-foreground/15 h-1 w-full rounded-full" />
        {/* The one question, with room around it. */}
        <span className="bg-muted-foreground/40 mt-auto h-1 w-4/5 rounded-full" />
        <span className="bg-muted-foreground/40 mb-auto h-1 w-3/5 rounded-full" />
        <span className="bg-muted-foreground/30 h-1.5 w-full rounded-full" />
      </div>
    </div>
  );
}

const THUMBS: Record<RespondentLayout, () => React.ReactElement> = {
  classic: ClassicThumb,
  focus: FocusThumb,
  broadsheet: BroadsheetThumb,
  horizon: HorizonThumb,
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
      // Two per row, and no wider ladder. Tailwind's breakpoints are VIEWPORT-based, so an
      // `xl:grid-cols-4` fired on a wide monitor even though this picker sits in a narrow settings
      // column — four cards crammed into ~120px each, with the descriptions falling into one-word
      // ladders. Two is what the column can actually hold.
      className="grid gap-3 sm:grid-cols-2"
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
