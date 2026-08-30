'use client';

/**
 * Sticky scroll-spy rail for a long, single-scroll panel of stacked sections
 * (the questionnaire settings panel, the round-detail page, …).
 *
 * Non-destructive wayfinding: the panel keeps its single vertical scroll (so
 * Cmd-F still finds everything), and this rail sits alongside it listing each
 * section with click-to-jump and a scroll-spy active highlight. It **discovers
 * sections from the DOM** — every `[data-section-rail]` (with an `id` and a
 * `data-section-label`) inside the `targetId` container — so the rail mirrors
 * exactly what rendered, including flag-gated sections, with no duplicated
 * visibility logic and no label drift from the section headings.
 *
 * The rail scrolls in its own right: once the list is taller than the viewport
 * the trailing sections were unreachable, because the sticky column clipped
 * them with nowhere to scroll — and a panel whose sections are folded shut is
 * too short to scroll the page far enough to save it. Its height is MEASURED
 * (top of the rail → bottom of the window) rather than written as a `100vh`
 * sum: the admin shell scrolls inside `<main>`, not the window, so any
 * hard-coded viewport arithmetic is wrong by however much chrome sits above —
 * which is exactly how the last item ended up below the fold.
 *
 * Past `FILTER_THRESHOLD` sections it grows a filter box. It matches the
 * section's *fields*, not just its heading — on a panel with a hundred settings
 * you know the one you want by name ("voice input") but not which group it
 * lives in — and it names the matching fields under the section, so the rail
 * answers "which group is that in?" without opening anything.
 *
 * Renders nothing until there are at least two sections to move between. Because
 * it can render nothing, a grid caller must pin its content to the content column
 * (e.g. `lg:col-start-2`) so the layout doesn't shift when the rail mounts.
 */
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/** Section count past which the rail is long enough to be worth filtering. */
const FILTER_THRESHOLD = 8;

interface RailItem {
  id: string;
  label: string;
  /** The section's own field labels — shown under a match so the hit is explained. */
  fields: string[];
  /** Lower-cased text of the whole section (heading + fields + prose) — the filter's target. */
  haystack: string;
}

/** How many matching field names to name under a section before trailing off. */
const MAX_FIELD_HINTS = 3;

/**
 * A section's field names, read from its `<label>`s. Deduped, and long ones dropped: a label
 * that runs to a sentence is help text wearing a label, and it makes a useless rail hint.
 */
function fieldLabels(section: HTMLElement): string[] {
  const seen = new Set<string>();
  for (const el of section.querySelectorAll('label')) {
    const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    if (text.length > 0 && text.length <= 48) seen.add(text);
  }
  return Array.from(seen);
}

interface SectionRailProps {
  /** id of the container element whose `[data-section-rail]` children form the rail. */
  targetId: string;
  /** Accessible label for the rail's <nav> — name the surface (e.g. "Settings sections"). */
  ariaLabel: string;
  /**
   * Called with the section id just before the rail scrolls to it. Lets a caller whose sections
   * can be folded shut (the settings panel) unfold the target first — jumping to a collapsed
   * card would otherwise land on a heading with nothing under it.
   */
  onJump?: (id: string) => void;
  className?: string;
}

/** The nearest ancestor that actually scrolls — `<main>` in the admin shell, else the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    // Styled scrollable isn't enough — an ancestor with nothing to scroll (scrollHeight ===
    // clientHeight) would never fire the 'scroll' listener the rail's height depends on.
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

export function SectionRail({ targetId, ariaLabel, onJump, className }: SectionRailProps) {
  const [items, setItems] = useState<RailItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const navRef = useRef<HTMLElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  // Discover sections from the DOM and keep the list in sync if a section
  // mounts/unmounts (e.g. a flag- or state-gated group).
  useEffect(() => {
    const container = document.getElementById(targetId);
    if (!container) return;

    const read = () => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('[data-section-rail]'))
        .filter((el) => el.id)
        .map((el) => ({
          id: el.id,
          label: el.dataset.sectionLabel ?? el.id,
          fields: fieldLabels(el),
          // `textContent` reads a folded section too — it is hidden, not unmounted — so the
          // filter still finds fields the admin cannot currently see.
          haystack: `${el.dataset.sectionLabel ?? ''} ${el.textContent ?? ''}`.toLowerCase(),
        }));
      setItems((prev) =>
        prev.length === found.length &&
        prev.every((p, i) => p.id === found[i]?.id && p.haystack === found[i]?.haystack)
          ? prev
          : found
      );
    };

    read();
    const observer = new MutationObserver(read);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [targetId]);

  // Scroll-spy: the active section is the topmost one currently in view.
  useEffect(() => {
    if (items.length === 0) return;
    const els = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const topmost = items.find((item) => visible.has(item.id));
        if (topmost) setActiveId(topmost.id);
      },
      // Bias the trigger line below the sticky workspace header so the active
      // item flips as a section's heading clears it.
      { rootMargin: '-120px 0px -55% 0px', threshold: [0, 1] }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

  // Keep the rail's height equal to the space left below it on screen, so its own scrollbar always
  // reaches the last section — whether the panel is pinned (sticky) or still in flow near the top.
  useEffect(() => {
    const el = navRef.current;
    if (el === null || items.length === 0) return;

    const measure = () => {
      const room = window.innerHeight - el.getBoundingClientRect().top - 16;
      // Ignore sub-pixel jitter; never collapse to nothing on a short window.
      setMaxHeight((prev) =>
        prev !== null && Math.abs(prev - room) < 4 ? prev : Math.max(160, Math.round(room))
      );
    };

    // The rail's top moves with every scroll until it pins, so the listener has to be cheap:
    // one measurement per frame, not one per scroll event.
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    measure();
    const scroller = scrollParent(el);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    scroller?.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      scroller?.removeEventListener('scroll', schedule);
    };
  }, [items.length]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (needle === '' ? items : items.filter((item) => item.haystack.includes(needle))).map(
        (item) => ({
          ...item,
          // Only worth naming the fields when they are what matched — an unfiltered rail is a
          // list of sections, not a list of every setting in the panel.
          hits:
            needle === ''
              ? []
              : item.fields
                  .filter((field) => field.toLowerCase().includes(needle))
                  .slice(0, MAX_FIELD_HINTS),
        })
      ),
    [items, needle]
  );

  if (items.length <= 1) return null;

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    onJump?.(id);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  };

  return (
    <nav aria-label={ariaLabel} className={className} ref={navRef}>
      {/* Own scroll box, capped to the room left on screen (see the measuring effect). The CSS
          fallback covers the first paint, before anything has been measured. */}
      <div
        className="flex max-h-[calc(100vh-12rem)] flex-col gap-2"
        style={maxHeight === null ? undefined : { maxHeight }}
      >
        {items.length >= FILTER_THRESHOLD && (
          <div className="relative shrink-0">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter goes to the first match — filter, hit Enter, you're there.
                if (event.key === 'Enter' && shown[0]) {
                  event.preventDefault();
                  jump(shown[0].id);
                }
              }}
              placeholder="Filter sections"
              aria-label={`Filter ${ariaLabel}`}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-8 w-full rounded-md border pr-2 pl-7 text-xs outline-none focus-visible:ring-2"
            />
          </div>
        )}
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain pr-1">
          {shown.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  aria-current={active ? 'location' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    jump(item.id);
                  }}
                  className={cn(
                    'block rounded-md border-l-2 px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-muted text-foreground border-[color:var(--cq-accent)] font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 border-transparent'
                  )}
                >
                  {item.label}
                </a>
                {item.hits.length > 0 && (
                  <ul className="text-muted-foreground mt-0.5 mb-1 space-y-0.5 pl-5 text-xs">
                    {item.hits.map((hit) => (
                      <li key={hit} className="truncate">
                        {hit}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="text-muted-foreground px-3 py-1.5 text-xs">No matching sections.</li>
          )}
        </ul>
      </div>
    </nav>
  );
}
