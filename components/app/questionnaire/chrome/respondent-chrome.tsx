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
 * So the shell measures itself: a flex column of exactly viewport height, with the chrome sizing to
 * its content and the surface taking the rest. Flex rather than the grid the plan called for,
 * because a three-row grid puts a lone child in row ONE — so a white-label page (no header, no
 * footer) would have had its conversation land in the header's row and size to content. Flex has no
 * such trap: absent chrome is simply absent, and `min-h-0` on the surface is what lets it shrink
 * rather than overflow.
 *
 * @see .context/app/questionnaire/respondent-chrome.md
 */

import type { ReactNode } from 'react';

import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav, PublicNavMenu } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';
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
}

export function RespondentChrome({
  mode,
  shell = true,
  children,
  className,
}: RespondentChromeProps) {
  return (
    // Exactly viewport height, not `min-h`: the surface inside scrolls its own conversation, so a
    // page that grew past the viewport would give the respondent two nested scrollbars and a
    // composer they have to scroll the PAGE to reach.
    <div className="bg-background flex h-dvh flex-col">
      {mode === 'full' && (
        <AppHeader logoHref="/" navigation={<PublicNav />} mobileMenu={<PublicNavMenu />} />
      )}

      {/* Co-branded: says who built it, and nothing more. No nav and no link — a respondent
          half-way through a questionnaire offered a route to our pricing page is a respondent who
          might take it, and the client chose this mode precisely to keep them here. */}
      {mode === 'co_branded' && (
        <div className="shrink-0 border-b">
          <div className="container mx-auto px-4 py-2.5">
            <ConquestWordmark size="nav" />
          </div>
        </div>
      )}

      {/* `min-h-0` is load-bearing: without it a flex child refuses to shrink below its content,
          the surface grows past the viewport, and the internal scroll never engages. */}
      <main className={cn('min-h-0 flex-1', shell && RESPONDENT_SHELL, className)}>{children}</main>

      {mode === 'full' && <PublicFooter />}
    </div>
  );
}
