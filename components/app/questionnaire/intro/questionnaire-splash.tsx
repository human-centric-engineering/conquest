'use client';

/**
 * QuestionnaireSplash — the respondent intro screen shown before the questionnaire starts.
 *
 * A calm, welcoming, white-labelled cover page: an admin-authored "about this questionnaire"
 * section (markdown, optionally cohort-overridden), then derived guidance — how it works (adapts to
 * the presentation mode), what you'll get at the end (adapts to the respondent-report settings), and
 * a few practical notes — closed by a single prominent proceed button. Inherits the client's brand
 * via the page's `BrandThemeProvider` CSS vars (`--app-accent-color`, `--app-cta-color`,
 * `--app-cta-gradient`), so it reads as the client's own surface, not a generic chrome. It's the
 * first surface of the workspace carousel: pressing the button (`onProceed`) slides to the
 * conversation and tells the workspace the session has started, which is what releases the deferred
 * first LLM turn. The respondent can slide back to re-read it any time via the Intro toggle.
 *
 * Layout note: the scroll lives on the outer block (`overflow-y-auto`) and the card centres with
 * `m-auto`, NOT `justify-center` on a flex row — a stretched flex child clips its own overflow
 * instead of scrolling, which is what cut long intros off mid-card. `m-auto` collapses to 0 when the
 * card outgrows the viewport, so tall intros scroll and short ones stay vertically centred.
 *
 * Sibling in tone to {@link SessionComplete} (the closing screen); together they bookend the run.
 */

import { useMemo } from 'react';
import Markdown from 'react-markdown';
import {
  ArrowRight,
  Check,
  Info,
  MessageSquareText,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_SOFT =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)';
const ACCENT_WASH =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 16%, transparent)';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 20%, transparent)';
const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

// A faint monochrome grain, baked once as a data URI. Sits at a hair of opacity over the card to
// kill the flat "filled rectangle" look without tinting — brand-agnostic, so it suits any client.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export interface QuestionnaireSplashProps {
  intro: ResolvedSessionIntro;
  /** Mount the workspace and begin (the parent {@link SessionEntry} swaps surfaces). */
  onProceed: () => void;
  className?: string;
}

export function QuestionnaireSplash({ intro, onProceed, className }: QuestionnaireSplashProps) {
  const { copy, background, questionnaireTitle } = intro;

  // Ordered, present-only sections so the reveal stagger and the section dividers stay coherent
  // whatever the config (report off → no "what you'll get"; no background → no "about" panel).
  const sections = useMemo(() => {
    const list: { key: string; icon: LucideIcon; heading: string; body: string }[] = [
      { key: 'how', icon: MessageSquareText, ...copy.howItWorks },
    ];
    if (copy.whatYouGet) {
      list.push({ key: 'get', icon: Sparkles, ...copy.whatYouGet });
    }
    return list;
  }, [copy]);

  // Reveal order: hero, [background], each section, good-to-know, CTA. A shared step counter keeps
  // the staggered delays in document order regardless of which optional blocks are present.
  let step = 0;
  const delay = () => ({ animationDelay: `${step++ * 70}ms`, animationFillMode: 'both' as const });
  const reveal =
    'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500';

  return (
    <div className={cn('h-full min-h-0 overflow-y-auto', className)}>
      {/* min-h-full + m-auto centres a short intro yet lets a tall one grow past the viewport so the
          OUTER block scrolls. (justify-center would clip the top of an overflowing card.) */}
      <div className="flex min-h-full w-full flex-col px-4 py-8 sm:py-12">
        <article
          className="bg-card relative m-auto w-full max-w-2xl overflow-hidden rounded-[1.75rem] border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_50px_-18px_rgba(0,0,0,0.22)]"
          aria-labelledby="intro-title"
        >
          {/* Atmosphere: a brand accent ribbon, a soft radial wash that bleeds from the top-left into
              the hero, and a near-invisible grain — depth without committing to any one palette. */}
          <span aria-hidden className="block h-1 w-full" style={{ background: CTA_FILL }} />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64"
            style={{
              background: `radial-gradient(135% 110% at 12% -10%, ${ACCENT_WASH} 0%, ${ACCENT_SOFT} 38%, transparent 72%)`,
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-multiply dark:opacity-[0.05] dark:mix-blend-screen"
            style={{ backgroundImage: GRAIN, backgroundSize: '140px 140px' }}
          />

          <div className="relative flex flex-col gap-9 px-7 py-10 sm:px-11 sm:py-12">
            {/* Hero */}
            <header className={cn('flex flex-col gap-3.5', reveal)} style={delay()}>
              <span
                className="inline-flex w-fit items-center gap-2 text-[0.7rem] font-semibold tracking-[0.18em] uppercase"
                style={{ color: ACCENT }}
              >
                <span
                  aria-hidden
                  className="h-px w-6"
                  style={{
                    background: `linear-gradient(to right, ${ACCENT}, transparent)`,
                  }}
                />
                Before you begin
              </span>
              <h1
                id="intro-title"
                className="text-foreground text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-[2.6rem]"
              >
                {questionnaireTitle}
              </h1>
              <p className="text-muted-foreground max-w-prose text-[0.95rem] leading-relaxed text-pretty sm:text-base">
                What this is about, and how it works — so the conversation starts on your terms.
              </p>
            </header>

            {/* Admin-authored "about this questionnaire" (markdown; cohort override already applied).
                An editorial lead: a left accent rule + the faintest tint, not a flat filled box. */}
            {background.trim().length > 0 && (
              <section
                className={cn('flex flex-col gap-3', reveal)}
                style={delay()}
                aria-label="About this questionnaire"
              >
                <h2 className="text-muted-foreground flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
                  About this questionnaire
                </h2>
                <div
                  className="relative overflow-hidden rounded-2xl border py-4 pr-5 pl-6"
                  style={{ borderColor: ACCENT_HAIRLINE, backgroundColor: ACCENT_SOFT }}
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-3 left-0 w-[3px] rounded-full"
                    style={{ background: CTA_FILL }}
                  />
                  <div className="prose prose-sm dark:prose-invert text-foreground/90 prose-p:leading-relaxed max-w-none">
                    <Markdown>{background}</Markdown>
                  </div>
                </div>
              </section>
            )}

            {/* Derived guidance — how it works / what you'll get. Grouped under a hairline so they read
                as one "what to expect" block rather than floating rows. */}
            <div
              className="flex flex-col gap-6 border-t pt-7"
              style={{ borderColor: 'color-mix(in srgb, var(--color-border) 70%, transparent)' }}
            >
              {sections.map((section) => (
                <section
                  key={section.key}
                  className={cn('flex items-start gap-4', reveal)}
                  style={delay()}
                >
                  <span
                    className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl"
                    style={{
                      backgroundColor: ACCENT_SOFT,
                      color: ACCENT,
                      boxShadow: `inset 0 0 0 1px ${ACCENT_HAIRLINE}`,
                    }}
                  >
                    <section.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-1 pt-0.5">
                    <h2 className="text-foreground text-[0.95rem] font-semibold tracking-tight">
                      {section.heading}
                    </h2>
                    <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                      {section.body}
                    </p>
                  </div>
                </section>
              ))}
            </div>

            {/* Good to know */}
            {copy.goodToKnow.length > 0 && (
              <section
                className={cn(
                  'bg-muted/40 rounded-2xl border px-5 py-4 backdrop-blur-[1px]',
                  reveal
                )}
                style={delay()}
                aria-label="Good to know"
              >
                <h2 className="text-muted-foreground mb-3 flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
                  <Info className="h-3.5 w-3.5" style={{ color: ACCENT }} aria-hidden="true" />
                  Good to know
                </h2>
                <ul className="flex flex-col gap-2.5">
                  {copy.goodToKnow.map((note, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <Check
                        className="mt-0.5 h-4 w-4 shrink-0"
                        style={{ color: ACCENT }}
                        aria-hidden="true"
                      />
                      <span className="text-foreground/90 text-sm leading-relaxed">{note}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Proceed */}
            <div className={cn('flex flex-col gap-3 pt-1', reveal)} style={delay()}>
              <button
                type="button"
                onClick={onProceed}
                className="group focus-visible:ring-ring relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl px-6 py-4 text-sm font-semibold text-white shadow-[0_8px_24px_-10px_rgba(0,0,0,0.5)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_-12px_rgba(0,0,0,0.55)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:translate-y-0 active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none sm:text-base"
                style={{ background: CTA_FILL }}
              >
                {/* A soft top sheen so the gradient reads as a raised surface, not a flat swatch. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent"
                />
                <span className="relative">{copy.buttonLabel}</span>
                <ArrowRight
                  className="relative h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
