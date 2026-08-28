'use client';

/**
 * RespondentDesignPicker — choose how the respondent surface is DRAWN.
 *
 * A card per design rather than a `<Select>`, for the same reason the layout picker is one: the
 * value is a *look*, and "Press" in a dropdown tells an admin nothing. It is the second of the two
 * settings on this tab chosen mostly by someone preparing a demo who wants to see what the client
 * will see, so the swatch has to do the explaining.
 *
 * ## Why these thumbnails carry colour when the layout picker's deliberately do not
 *
 * The layout picker's are grey on purpose: the client's brand is a separate axis, so tinting a
 * layout swatch would imply that control governs colour, which it does not. Here it does — `marque`
 * is *about* the brand becoming structure — so a colourless swatch would hide the whole point of
 * the choice. The accent used is `--cq-accent`, the ConQuest admin accent, NOT a client's: this
 * picker is shown before any particular client is in mind, and the swatch is illustrating where
 * colour lands, not which colour.
 *
 * The swatches are drawn with the same primitives the designs themselves use — corner radius, rule
 * weight, where the accent falls — rather than being screenshots, so they cannot go stale against a
 * stylesheet they are supposed to describe.
 *
 * Copy comes from `RESPONDENT_DESIGN_META`, the same source the exported settings table reads, so
 * the picker and a client-facing PDF can never disagree about what a design is called.
 */

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { RESPONDENT_DESIGN_META } from '@/lib/app/questionnaire/layout/catalog';
import { RESPONDENT_DESIGNS, type RespondentDesign } from '@/lib/app/questionnaire/types';

/** The ConQuest admin accent — illustrating WHERE colour falls, never which colour a client uses. */
const ACCENT = 'var(--cq-accent, var(--color-primary))';

/**
 * Soft corners, a filled answer bubble, a rounded field. The look every questionnaire has had.
 *
 * Each swatch shows the same four things — a header band, an interviewer turn, the respondent's
 * answer, the answer box — so the three read as three answers to one question rather than three
 * unrelated pictures.
 */
function RoundedThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full flex-col gap-1 rounded-sm p-1.5">
      <span className="bg-muted-foreground/20 h-2 w-full rounded-md" />
      <div className="flex items-start gap-1">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ACCENT }} />
        <span className="bg-muted-foreground/25 h-1 w-4/5 rounded-full" />
      </div>
      <span
        className="ml-auto h-2.5 w-1/2 rounded-lg"
        style={{ background: `color-mix(in srgb, ${ACCENT} 22%, transparent)` }}
      />
      <span className="bg-background mt-auto h-2.5 w-full rounded-md border" />
    </div>
  );
}

/**
 * Straight lines and hairline rules; the answer set against a rule rather than filled; the field
 * the only thing with a corner left.
 */
function PressThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full flex-col gap-1 p-1.5">
      <span className="bg-muted-foreground/20 h-2 w-full" />
      <div className="flex items-start gap-1">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0" style={{ background: ACCENT }} />
        <span className="bg-muted-foreground/25 h-1 w-4/5" />
      </div>
      {/* The margin-note treatment: no fill, a rule down the edge it is set against. */}
      <span
        className="ml-auto h-2.5 w-1/2 border-r-2"
        style={{ borderColor: ACCENT, background: 'transparent' }}
      />
      <span className="bg-background mt-auto h-2.5 w-full rounded-[2px] border" />
    </div>
  );
}

/**
 * The brand as structure: a rule closing the header, a spine down the conversation, the mark
 * standing in for the interviewer's dot, and an accent-edged answer box.
 *
 * The spine is the detail that has to survive at 56px — it is what separates this swatch from the
 * Press one at a glance, and it is also the design's most visible move on a real page.
 */
function MarqueThumb() {
  return (
    <div className="bg-muted/60 flex h-full w-full flex-col gap-1 p-1.5">
      <span
        className="bg-muted-foreground/20 h-2 w-full border-b-2"
        style={{ borderColor: ACCENT }}
      />
      {/* The spine, and the mark that signs the question beside it. */}
      <div className="flex items-start gap-1 border-l-2 pl-1" style={{ borderColor: ACCENT }}>
        <span className="mt-0.5 h-2 w-2 shrink-0" style={{ background: ACCENT }} />
        <span className="bg-muted-foreground/25 h-1 w-3/4" />
      </div>
      <span
        className="ml-auto h-2.5 w-1/2"
        style={{ background: `color-mix(in srgb, ${ACCENT} 32%, transparent)` }}
      />
      <span
        className="bg-background mt-auto h-2.5 w-full border-2"
        style={{ borderColor: ACCENT }}
      />
    </div>
  );
}

const THUMBS: Record<RespondentDesign, () => React.ReactElement> = {
  rounded: RoundedThumb,
  press: PressThumb,
  marque: MarqueThumb,
};

export interface RespondentDesignPickerProps {
  value: RespondentDesign;
  onChange: (value: RespondentDesign) => void;
  disabled?: boolean;
}

export function RespondentDesignPicker({
  value,
  onChange,
  disabled = false,
}: RespondentDesignPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Respondent design"
      // Two per row, matching the layout picker above it. Tailwind's breakpoints are VIEWPORT-based
      // and this sits in a narrow settings column, so a wider ladder fires on a big monitor and
      // crushes the descriptions into one-word columns — the same trap the layout picker documents.
      className="grid gap-3 sm:grid-cols-2"
    >
      {RESPONDENT_DESIGNS.map((key) => {
        const meta = RESPONDENT_DESIGN_META[key];
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
