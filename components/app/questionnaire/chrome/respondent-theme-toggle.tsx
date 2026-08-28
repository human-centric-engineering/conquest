'use client';

/**
 * The respondent's light/dark switch.
 *
 * Every other surface in the product has one — the marketing header, the admin shell, the
 * signed-in app — because they all render `HeaderActions`. The three standalone respondent
 * pages do not: they left the `(public)` group precisely to shed that header, and took the
 * switch with them. A respondent answering a long questionnaire at night had no way to change
 * it, which is the one context in the product where somebody is reading continuous prose for
 * twenty minutes.
 *
 * It lives in the CHROME rather than in a layout because the chrome wraps all four layouts and
 * all three chrome modes: one control, no layout able to omit it, and nothing for a new layout
 * to remember. (The alternative — a slot in the layout contract — would have made each layout
 * place it, which is the right shape for a questionnaire feature and the wrong shape for a
 * viewing preference that has nothing to do with the questionnaire.)
 *
 * `full` chrome already has one inside `AppHeader`'s actions, so this renders for `co_branded`
 * and `white_label` only — see `RespondentChrome`.
 *
 * ## Why it is not the platform's ThemeToggle
 *
 * `components/theme-toggle.tsx` is a bordered `outline` button sized for a header row. Under
 * white-label chrome there is no header row: the control sits alone above the questionnaire, on
 * the client's own canvas, and a boxed button reads as a piece of UI someone forgot to remove.
 * This is the same behaviour (same `useTheme`, same icons, same one-click flip) at the weight
 * the surface can carry — and it uses `currentColor`, so it inherits the client's ink rather
 * than declaring a colour of its own.
 */

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

export function RespondentThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  // The name states the DESTINATION, and the destination is only knowable on the client:
  // `ThemeProvider` initialises to `light` on the server and reads storage after mount, so
  // interpolating `theme` straight into the label handed a respondent whose stored preference is
  // dark a server-rendered "Switch to dark mode" against a client "Switch to light mode" — a
  // hydration attribute mismatch on every load. Gating on mount makes both paints agree on the
  // neutral name and lets the accurate one land a tick later, which is the same trick the icons
  // below play with CSS. It cannot be done in CSS here: an accessible name assembled from
  // display-swapped spans is only correct where CSS actually runs.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const label = mounted ? `Switch to ${next} mode` : 'Toggle theme';

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-70',
        'transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current focus-visible:outline-none',
        className
      )}
    >
      {/* Both icons are rendered and swapped by the `.dark` class rather than by `theme`, so the
          server and the first client paint agree. Reading `theme` here would render the light
          icon on the server for a respondent whose stored preference is dark, and hydration
          would flip it — a visible blink on every page load. */}
      <Sun className="h-4 w-4 dark:hidden" aria-hidden />
      <Moon className="hidden h-4 w-4 dark:block" aria-hidden />
    </button>
  );
}
