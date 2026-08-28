'use client';

/**
 * RespondentFooter — the one line ConQuest is entitled to at the foot of a questionnaire.
 *
 * The respondent surface used to close with the platform's `PublicFooter`, which is a *marketing*
 * footer: it restates the header's nav (Home / Capabilities / Pricing / Contact), adds the legal
 * cluster, and — since Sunrise 0.11.1 — an attribution line. On `/`, that is correct; a marketing
 * page is a document you are meant to leave, and the footer is the map of where to go next. On a
 * questionnaire it is three separate mistakes stacked:
 *
 *   - **It repeats the header verbatim.** `full` chrome renders `PublicNav` at the top with exactly
 *     those four links. Saying them twice on a surface whose entire job is one conversation is
 *     duplication a respondent has to read past.
 *   - **Every one of those links leads AWAY mid-answer.** The `co_branded` mode already refuses to
 *     offer a route to Pricing halfway through a questionnaire. `full` mode keeps our header — it
 *     was never an argument for doubling the exits.
 *   - **The attribution is noise here.** "© 2026 All Too Human Ltd" is a claim about a marketing
 *     site. The respondent is not reading our site; they are answering a client's questions.
 *
 * So this is the ConQuest footer: the legal cluster and the consent control, on one quiet line, and
 * nothing else. It is deliberately the *smallest* footer that is still a real one — CUSTOMIZATION.md
 * §4 is explicit that a fork supplying its own frame has to render **Cookie Preferences** itself,
 * because consent is a legal requirement in many jurisdictions rather than a design choice. It does.
 *
 * Legal links stay seam-driven (`footerLegalItems` in `lib/app/public-nav.ts`) so this footer and
 * the marketing one cannot disagree about where Privacy lives. The header nav list is deliberately
 * NOT read: dropping it is the point, not a configuration.
 *
 * Lives in `components/app/**` — the reserved fork tier — so an upstream sync merges around it
 * rather than through it. That is the documented answer to "this surface needs a different frame",
 * and it replaces the older one, which was holding a deletion against a platform file.
 *
 * @see components/app/questionnaire/chrome/respondent-chrome.tsx — the only caller
 * @see CUSTOMIZATION.md — "When a surface needs a different frame"
 */

import Link from 'next/link';

import { useConsent } from '@/lib/consent';
import { footerLegalItems } from '@/lib/app/public-nav';
import { DEFAULT_FOOTER_LEGAL } from '@/lib/public-nav/types';

// Same replace-with-fallback read as the platform footer, so a fork that repoints Privacy repoints
// it in both places from one edit.
const legalLinks = footerLegalItems ?? DEFAULT_FOOTER_LEGAL;

export function RespondentFooter() {
  const { openPreferences } = useConsent();

  return (
    // `shrink-0`: the shell around this is a flex column of exactly viewport height, and the
    // conversation takes what the chrome leaves. A footer that could be compressed would be
    // compressed, since the surface above it is the one thing eager to grow.
    <footer className="shrink-0 border-t">
      <nav
        aria-label="Legal"
        className="text-muted-foreground container mx-auto flex flex-wrap items-center justify-center gap-x-5 gap-y-1 px-4 py-2.5 text-xs"
      >
        {legalLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="hover:text-foreground transition-colors"
          >
            {link.label}
          </Link>
        ))}
        {/* Not optional and not seam-driven, exactly as in the platform footer: a frame that opts
            out of `PublicFooter` inherits the obligation to carry consent, not permission to drop
            it. */}
        <button
          type="button"
          onClick={openPreferences}
          className="hover:text-foreground transition-colors"
        >
          Cookie Preferences
        </button>
      </nav>
    </footer>
  );
}
