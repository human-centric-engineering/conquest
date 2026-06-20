'use client';

/**
 * QuestionnaireSplash — the respondent intro screen shown before the questionnaire starts.
 *
 * A calm, welcoming, white-labelled cover page: an admin-authored "about this questionnaire"
 * section (markdown, optionally cohort-overridden), then derived guidance — how it works (adapts to
 * the presentation mode), what you'll get at the end (adapts to the respondent-report settings), and
 * a few practical notes — closed by a single prominent proceed button. Inherits the client's brand
 * via the page's `BrandThemeProvider` CSS vars (`--app-accent-color`, `--app-cta-color`,
 * `--app-cta-gradient`), so it reads as the client's own surface, not a generic chrome. Pressing the
 * button mounts the workspace ({@link SessionEntry} owns that swap), which is what defers the first
 * LLM turn until the respondent has chosen to begin.
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
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 12%, transparent)';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 22%, transparent)';
const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

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
    <div className={cn('flex h-full min-h-0 justify-center overflow-y-auto px-4 py-8', className)}>
      <div className="flex w-full max-w-2xl flex-col">
        <article
          className="bg-card relative overflow-hidden rounded-3xl border shadow-sm"
          aria-labelledby="intro-title"
        >
          {/* Brand accent ribbon + a soft wash behind the hero, both keyed off the client accent. */}
          <span aria-hidden className="block h-1.5 w-full" style={{ background: CTA_FILL }} />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-48"
            style={{
              background: `radial-gradient(120% 100% at 50% 0%, ${ACCENT_SOFT} 0%, transparent 70%)`,
            }}
          />

          <div className="relative flex flex-col gap-8 px-7 py-9 sm:px-10 sm:py-11">
            {/* Hero */}
            <header className={cn('flex flex-col gap-3', reveal)} style={delay()}>
              <span
                className="inline-flex w-fit items-center gap-2 text-xs font-medium tracking-wide uppercase"
                style={{ color: ACCENT }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
                Before you begin
              </span>
              <h1
                id="intro-title"
                className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl"
              >
                {questionnaireTitle}
              </h1>
              <p className="text-muted-foreground text-sm text-pretty sm:text-base">
                Here’s what to expect — it only takes a moment to read, then you’re ready to start.
              </p>
            </header>

            {/* Admin-authored "about this questionnaire" (markdown; cohort override already applied). */}
            {background.trim().length > 0 && (
              <section
                className={cn('flex flex-col gap-2.5', reveal)}
                style={delay()}
                aria-label="About this questionnaire"
              >
                <h2 className="text-foreground text-sm font-semibold tracking-tight">
                  About this questionnaire
                </h2>
                <div
                  className="rounded-2xl border px-5 py-4"
                  style={{ borderColor: ACCENT_HAIRLINE, backgroundColor: ACCENT_SOFT }}
                >
                  <div className="prose prose-sm dark:prose-invert text-foreground/90 max-w-none">
                    <Markdown>{background}</Markdown>
                  </div>
                </div>
              </section>
            )}

            {/* Derived guidance — how it works / what you'll get. */}
            <div className="flex flex-col gap-5">
              {sections.map((section) => (
                <section
                  key={section.key}
                  className={cn('flex items-start gap-4', reveal)}
                  style={delay()}
                >
                  <span
                    className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: ACCENT_SOFT, color: ACCENT }}
                  >
                    <section.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-1">
                    <h2 className="text-foreground text-sm font-semibold tracking-tight">
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
                className={cn('rounded-2xl border px-5 py-4', reveal)}
                style={delay()}
                aria-label="Good to know"
              >
                <h2 className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
                  <Info className="h-3.5 w-3.5" aria-hidden="true" />
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
                className="group focus-visible:ring-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition-[transform,box-shadow] hover:shadow-md focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.99] motion-reduce:active:scale-100 sm:text-base"
                style={{ background: CTA_FILL }}
              >
                {copy.buttonLabel}
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
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
