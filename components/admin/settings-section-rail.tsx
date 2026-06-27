'use client';

/**
 * Sticky scroll-spy rail for a long, single-scroll panel of stacked sections
 * (the questionnaire settings panel, the round-detail page, …).
 *
 * Non-destructive wayfinding: the panel keeps its single vertical scroll (so
 * Cmd-F still finds everything), and this rail sits alongside it listing each
 * section with click-to-jump and a scroll-spy active highlight. It **discovers
 * sections from the DOM** — every `[data-settings-section]` (with an `id` and a
 * `data-section-label`) inside the `targetId` container — so the rail mirrors
 * exactly what rendered, including flag-gated sections, with no duplicated
 * visibility logic and no label drift from the section headings.
 *
 * Renders nothing until there are at least two sections to move between.
 */
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

interface RailItem {
  id: string;
  label: string;
}

interface SettingsSectionRailProps {
  /** id of the container element whose `[data-settings-section]` children form the rail. */
  targetId: string;
  className?: string;
}

export function SettingsSectionRail({ targetId, className }: SettingsSectionRailProps) {
  const [items, setItems] = useState<RailItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Discover sections from the DOM and keep the list in sync if a section
  // mounts/unmounts (e.g. a flag- or state-gated group).
  useEffect(() => {
    const container = document.getElementById(targetId);
    if (!container) return;

    const read = () => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('[data-settings-section]'))
        .filter((el) => el.id)
        .map((el) => ({ id: el.id, label: el.dataset.sectionLabel ?? el.id }));
      setItems((prev) =>
        prev.length === found.length && prev.every((p, i) => p.id === found[i]?.id) ? prev : found
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

  if (items.length <= 1) return null;

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  };

  return (
    <nav aria-label="Settings sections" className={className}>
      <ul className="space-y-0.5">
        {items.map((item) => {
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
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
