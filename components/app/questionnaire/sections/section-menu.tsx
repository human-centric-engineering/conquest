'use client';

/**
 * Sectioned interviews (P21) — where the respondent is, and the way to somewhere else.
 *
 * One quiet control: the current section's name, its place in the run, and a chevron opening the
 * rest. Renders nothing when the interview is not sectioned, which is most of them, so every layout
 * can place it unconditionally.
 *
 * **It used to be a tab strip**, and the strip is gone rather than hidden. Three things were wrong
 * with it and only the third is about small screens:
 *
 *  1. A row of pills is the loudest thing in a conversation that is meant to be read. It announced
 *     the instrument's filing structure above every reply.
 *  2. Section labels are sentences ("Opening — Situation, Goals, Challenges, Impact"), not tab
 *     words, so the strip was wide at any width and truncating it took away the one thing a tab is
 *     for.
 *  3. Below about 30rem it degraded into a horizontal scroller cropped to its first tab, with every
 *     other section behind a gesture nothing advertised.
 *
 * Naming the current section and putting the others one press away answers all three, and it is
 * what the strip already fell back to on a narrow column — so this is the fallback becoming the
 * whole design rather than a new one.
 *
 * Beside the trigger, and only when the two differ, sits the way BACK: picking a section moves the
 * conversation into it, so a respondent who returns to an earlier section to add a line has quietly
 * moved the interview with them. Without a named way back, the only route on is a menu they have to
 * reason about, and the section they were in is not marked in it — every row looks equally like a
 * destination. It names the section rather than saying "back", because "back" from a list they
 * chose from is not obviously a place.
 *
 * No variants. Every layout gets this same control, and each still decides WHERE it goes (the
 * conversation card's header band in Classic, the margin in Broadsheet, beside the composer in
 * Focus and Horizon) — which is the decision the slot contract exists to give them.
 *
 * Brand colours come from the page's `BrandThemeProvider` vars, the same way the answers panel and
 * the intro splash take theirs. The list is a white-labelled surface: left on the platform's own
 * popover tokens it reads as a system menu dropped into a client's interview, and the browser's
 * default focus ring lands on the first row the moment it opens, which is then the loudest thing on
 * the screen.
 *
 * The list is PORTALLED, so wearing the brand takes one more step than tinting it. Radix renders the
 * popover on `document.body`, outside the provider's div, where it inherits neither the client's
 * `--app-*` variables nor `data-surface="respondent"` — so the tints below resolve to their platform
 * fallbacks and the neutral palette underneath them reverts to the surrounding ConQuest consumer
 * brand. The symptom is a cream-and-blue menu in the middle of a magenta questionnaire, and it is
 * not subtle. `useRespondentSurfaceAttrs` is the seam the answers drawer already established for
 * exactly this; spreading it onto the content root is what makes every colour here resolve against
 * the client's theme rather than the platform's.
 */

import { useState } from 'react';
import { Check, ChevronDown, CornerUpLeft, Lock } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRespondentSurfaceAttrs } from '@/components/app/questionnaire/chat/respondent-surface-context';
import { cn } from '@/lib/utils';
import {
  resumeSectionKey,
  type SectionStripView,
  type SectionTabView,
} from '@/lib/app/questionnaire/sections/view';

// Brand-tint tokens, in the same key as the answers panel's: a whisper of accent through the
// popover paper and its hairline, a stronger wash for the row they are in, and the accent itself
// for the focus ring and the "you are here" mark.
const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_SURFACE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 4%, var(--color-popover))';
const ACCENT_BORDER =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 22%, var(--color-border))';
const ACCENT_ROW =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 12%, transparent)';
const ACCENT_ROW_HOVER =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 6%, transparent)';

export interface SectionMenuProps {
  view: SectionStripView;
  /** Called with the section key when the respondent picks one. */
  onSelect: (key: string) => void;
  /** False while a turn is in flight — moving mid-stream would strand the reply. */
  canSelect: boolean;
  className?: string;
}

/** The sections a given view actually offers: locked ones are hidden when the version says so. */
function visibleSections(view: SectionStripView): SectionTabView[] {
  return view.showLocked ? view.sections : view.sections.filter((tab) => tab.isAvailable);
}

/** One row of the list. */
function SectionRow({
  tab,
  total,
  onSelect,
  canSelect,
}: {
  tab: SectionTabView;
  total: number;
  onSelect: (key: string) => void;
  canSelect: boolean;
}) {
  const disabled = !canSelect || !tab.isAvailable;
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.key)}
      disabled={disabled}
      // `aria-current` rather than a visual-only active state: the list is shut most of the time, so
      // the section they are in has to be announced rather than merely tinted.
      aria-current={tab.isActive ? 'step' : undefined}
      className={cn(
        // `items-start` with a wrapping label, not `truncate`: section labels are sentences
        // ("Opening — Situation, Goals, Challenges, Impact"), and a list that clips the one thing it
        // exists to name is no better than the tab strip it replaced.
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-snug transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1',
        tab.isActive
          ? 'text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground',
        disabled && !tab.isActive && 'hover:text-muted-foreground opacity-50'
      )}
      // Inline rather than utility classes because all three are brand-mixed: `bg-muted` and the
      // browser's own focus ring are the platform's neutrals, and both read blue-grey beside a
      // client's magenta. Same idiom the splash and the answers panel already use for their tints.
      style={{
        outlineColor: ACCENT,
        backgroundColor: tab.isActive ? ACCENT_ROW : undefined,
      }}
      onMouseEnter={(e) => {
        if (!tab.isActive && !disabled) e.currentTarget.style.backgroundColor = ACCENT_ROW_HOVER;
      }}
      onMouseLeave={(e) => {
        if (!tab.isActive) e.currentTarget.style.backgroundColor = '';
      }}
    >
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
        {tab.status === 'closed' ? (
          <Check className="size-3.5" aria-hidden />
        ) : !tab.isAvailable ? (
          <Lock className="size-3" aria-hidden />
        ) : tab.isActive ? (
          // The same small accent mark the answers panel uses for "you are here".
          // `--color-primary` as the fallback, not `--primary`: the latter is not a token in this
          // theme, so an unbranded questionnaire drew this mark in whatever the browser made of an
          // undefined variable.
          <span
            className="size-1.5 rounded-[1px]"
            style={{ backgroundColor: ACCENT }}
            aria-hidden
          />
        ) : null}
      </span>
      <span className="min-w-0">{tab.label}</span>
      <span className="sr-only">
        {` (part ${tab.position} of ${total}`}
        {tab.status === 'closed' ? ', finished' : !tab.isAvailable ? ', not available yet' : ''}
        {')'}
      </span>
    </button>
  );
}

export function SectionMenu({ view, onSelect, canSelect, className }: SectionMenuProps) {
  // Before the early returns: they are hooks, and the guards below are conditional. `null` when
  // there is no provider above — the admin's read-only replay renders this too, and there is no
  // client brand there to wear.
  const surface = useRespondentSurfaceAttrs();
  // Controlled, so picking a section can shut it. Radix closes a popover on an outside press or
  // Escape, and a row is neither: the list stayed open over the section it had just moved to,
  // covering the reply arriving underneath it.
  const [open, setOpen] = useState(false);

  if (!view.active) return null;
  const sections = visibleSections(view);
  if (sections.length === 0) return null;

  const active = view.sections.find((tab) => tab.isActive);
  const total = view.sections.length;

  // Where the interview would otherwise carry on. Shown only when the respondent has moved away
  // from it, so a straight run through never sees this at all.
  const resumeKey = resumeSectionKey(view);
  const resume =
    // `view.activeKey` guards the run that has not started: before the first section opens there is
    // no section they have moved away FROM, and offering to send them to the one they are about to
    // start anyway would be a control that does nothing.
    resumeKey && view.activeKey && resumeKey !== view.activeKey
      ? (view.sections.find((tab) => tab.key === resumeKey) ?? null)
      : null;

  // Picking a section is a move, so the list has done its job. Shut it before the move rather
  // than after: the strip redraws when the move lands, and closing on that would read as a lag.
  const selectAndClose = (key: string) => {
    setOpen(false);
    onSelect(key);
  };

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            // Not a `Button`: every variant of it draws a control, and this has to read as a line of
            // context that happens to be pressable. The hover tint is the only thing that says so
            // until it is reached, which is the whole brief — subtle, not invisible.
            className="group/section text-muted-foreground hover:text-foreground hover:bg-muted/60 -mx-1.5 flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors"
          >
            <span className="text-foreground/90 truncate font-medium">
              {active ? active.label : 'Sections'}
            </span>
            {active ? (
              <span className="shrink-0 tabular-nums">
                {active.position} of {total}
              </span>
            ) : null}
            <ChevronDown
              className="size-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]/section:rotate-180"
              aria-hidden
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          {...surface}
          align="start"
          // Sized to the labels rather than to a fixed width: `w-max` lets a long section name have
          // the room it needs, the floor stops a run of short ones collapsing into a thin strip, and
          // the ceiling is the smaller of 26rem and the viewport, so a phone never gets a menu it has
          // to scroll sideways.
          className="w-max max-w-[min(26rem,calc(100vw-2rem))] min-w-64 p-1.5"
          // The surface's own variables FIRST, then this component's tints: the tints are `color-mix`
          // expressions that read those variables, so they have to be applied on the same element that
          // defines them, and they must not overwrite it.
          style={{ ...surface?.style, backgroundColor: ACCENT_SURFACE, borderColor: ACCENT_BORDER }}
        >
          {/* Quiet heading in the same key as the answers panel's group labels — the list needs to say
            what it is a list OF, since the trigger that opened it is now out of view. */}
          <p className="text-muted-foreground/70 px-2 pt-1 pb-1.5 text-[10px] font-medium tracking-wide uppercase">
            Sections
          </p>
          <div className="flex flex-col gap-0.5" role="group" aria-label="Sections">
            {sections.map((tab) => (
              <SectionRow
                key={tab.key}
                tab={tab}
                total={total}
                onSelect={selectAndClose}
                canSelect={canSelect}
              />
            ))}
          </div>
          {/* Only when the list can actually grow — Conditional Topics seats new topics as the plan
            lands, and a respondent amendment can seat one later still. On a fixed instrument this
            would be a promise the questionnaire cannot keep, and someone who read it would go on
            waiting for a section that is never coming. */}
          {view.canGrow ? (
            <p
              className="text-muted-foreground/80 mt-1.5 px-2 pt-2 pb-1 text-[11px] leading-snug"
              style={{ borderTop: `1px solid ${ACCENT_BORDER}` }}
            >
              More sections can appear as the conversation develops, if they turn out to be
              relevant.
            </p>
          ) : null}
        </PopoverContent>
      </Popover>

      {/* The way back. Quieter than the trigger beside it — it is an offer, not the label of where
          they are — and it names its destination, because "back" from a list the respondent chose
          from is not obviously a place. Disabled on the same rule as the rows: moving mid-stream
          would strand the reply that is still arriving. */}
      {resume ? (
        <button
          type="button"
          onClick={() => onSelect(resume.key)}
          disabled={!canSelect}
          className="text-muted-foreground/80 hover:bg-muted/60 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          style={{ outlineColor: ACCENT }}
          onMouseEnter={(e) => {
            if (canSelect) e.currentTarget.style.color = ACCENT;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '';
          }}
        >
          <CornerUpLeft className="size-3 shrink-0" aria-hidden />
          <span className="truncate">Back to {resume.label}</span>
        </button>
      ) : null}
    </div>
  );
}
