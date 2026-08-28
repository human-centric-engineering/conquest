/**
 * RespondentChrome — what surrounds a respondent surface, and how much of it is ours.
 *
 * The three standalone respondent pages (`/q`, `/x`, `/m`) used to sit in the `(public)` route
 * group, which meant every questionnaire link — including one sent by a client presenting the
 * instrument as their own — arrived wrapped in the ConQuest marketing header and footer, complete
 * with a Pricing link a respondent could wander into mid-answer. They now sit in `(respondent)`,
 * which renders no chrome of its own, and each page renders this instead with the chrome its
 * questionnaire asked for.
 *
 * ## It also owns the height, and that is the point
 *
 * The conversation is a fixed-height surface that scrolls internally, so something has to say how
 * tall it is. Until now each page did its own arithmetic against the chrome it assumed: `100dvh-9rem`
 * on `/q`, `100vh-8rem` on `/x`, `100vh-12rem` on the signed-in surface, and a `/q/loading.tsx` that
 * used a different width from the page it stands in for. Four numbers describing one thing, none of
 * them checkable, and all of them wrong the moment the chrome above them becomes a setting.
 *
 * ## And it carries the theme switch
 *
 * Every other surface in the product has one, via `HeaderActions`. These three pages shed that
 * header when they left the `(public)` group and lost the switch with it — in the one place where
 * somebody reads continuous prose for twenty minutes, possibly at night. `full` chrome still gets
 * it from `AppHeader`; `co_branded` and `white_label` render `RespondentThemeToggle` here. Putting
 * it in the chrome rather than in the layouts means all four layouts have it and none of them had
 * to be told.
 *
 * ## So the shell measures itself
 *
 * A flex column of exactly viewport height, with the chrome sizing to
 * its content and the surface taking the rest. Flex rather than the grid the plan called for,
 * because a three-row grid puts a lone child in row ONE — so a white-label page (no header, no
 * footer) would have had its conversation land in the header's row and size to content. Flex has no
 * such trap: absent chrome is simply absent, and `min-h-0` on the surface is what lets it shrink
 * rather than overflow.
 *
 * @see .context/app/questionnaire/respondent-chrome.md
 */

import type { CSSProperties, ReactNode } from 'react';

import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav, PublicNavMenu } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';
import { RespondentThemeToggle } from '@/components/app/questionnaire/chrome/respondent-theme-toggle';
import { RESPONDENT_SHELL } from '@/lib/app/questionnaire/layout';
import { cn } from '@/lib/utils';
import type { RespondentChrome as RespondentChromeMode } from '@/lib/app/questionnaire/types';

export interface RespondentChromeProps {
  /**
   * How much of ConQuest to show. Already narrowed and defaulted by the page's resolver, so an
   * unrecognised stored value has become `full` long before it reaches here.
   */
  mode: RespondentChromeMode;
  /**
   * Put the surface inside {@link RESPONDENT_SHELL} — the shared width the conversation is read
   * at. On by default. `/m` opts in like the rest; a page that manages its own width (a takeover,
   * an error state) passes `false`.
   */
  shell?: boolean;
  children: ReactNode;
  /** Extra classes for the surface row, not the shell around it. */
  className?: string;
  /**
   * The client's ground, as the two canvas variables and nothing else
   * (`canvasBackdropVars`). Applied to the shell so the backdrop rules in `brand-theme.css` can
   * read it — the brand proper lives on the surface root INSIDE `<main>`, which the theme-switch
   * row and the gutters either side of the column are ancestors of and so cannot inherit from.
   *
   * Only the ground travels. Hoisting the whole brand here would repaint the ConQuest header and
   * footer with it, and `full` chrome is the mode that explicitly keeps them ours.
   */
  canvasStyle?: CSSProperties;
}

export function RespondentChrome({
  mode,
  shell = true,
  children,
  className,
  canvasStyle,
}: RespondentChromeProps) {
  return (
    // Exactly viewport height, not `min-h`: the surface inside scrolls its own conversation, so a
    // page that grew past the viewport would give the respondent two nested scrollbars and a
    // composer they have to scroll the PAGE to reach.
    <div className="bg-background flex h-dvh flex-col" style={canvasStyle}>
      {mode === 'full' && (
        <AppHeader logoHref="/" navigation={<PublicNav />} mobileMenu={<PublicNavMenu />} />
      )}

      {/* Co-branded: says who built it, and nothing more. No nav and no link — a respondent
          half-way through a questionnaire offered a route to our pricing page is a respondent who
          might take it, and the client chose this mode precisely to keep them here. The theme
          switch is the one exception, and it is not a route anywhere: it changes how THIS page
          looks. */}
      {mode === 'co_branded' && (
        <div className="shrink-0 border-b">
          <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-2.5">
            <ConquestWordmark size="nav" />
            <RespondentThemeToggle />
          </div>
        </div>
      )}

      {/* White-label: a bar carrying nothing but the switch.
          Deliberately a ROW in the shell rather than a floating control over the surface. The
          shell is a flex column whose surface takes exactly the space the chrome leaves, and a
          floating button would sit over a layout that has no idea it is there — Horizon is
          full-bleed, and the answers-drawer trigger already owns a corner. A row cannot overlap
          anything, and the surface shrinks to fit it by construction.
          It is not a white-label violation: a sun and a moon are not our branding, and the mode
          exists to keep ConQuest's identity off the page, not to strip the respondent of a
          viewing preference every other surface in the product offers. */}
      {mode === 'white_label' && (
        // `cq-respondent-backdrop`, not the inherited `bg-background`: this page has no chrome of
        // ours, but the shell it sits in is still classified a CONSUMER surface, so the row was
        // painting ConQuest cream (or deep navy) in a ~40px strip directly above the client's
        // canvas — on the one mode whose entire purpose is that our colours do not appear.
        <div className="cq-respondent-backdrop flex shrink-0 justify-end px-4 pt-2">
          <RespondentThemeToggle />
        </div>
      )}

      {/* `min-h-0` is load-bearing: without it a flex child refuses to shrink below its content,
          the surface grows past the viewport, and the internal scroll never engages. */}
      <main className={cn('min-h-0 flex-1', shell && RESPONDENT_SHELL, className)}>{children}</main>

      {mode === 'full' && <PublicFooter />}
    </div>
  );
}
