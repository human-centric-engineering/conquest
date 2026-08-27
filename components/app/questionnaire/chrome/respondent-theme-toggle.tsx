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

import { Moon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

export function RespondentThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      // Named by what it DOES, in plain words, and stating the destination rather than the
      // current state — "Dark mode" alone leaves a screen-reader user guessing whether it
      // describes the button or the page.
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
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
