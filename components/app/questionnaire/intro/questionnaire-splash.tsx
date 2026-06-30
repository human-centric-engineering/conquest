'use client';

/**
 * QuestionnaireSplash — the respondent intro screen, the first surface of the workspace carousel.
 *
 * A two-panel briefing that fills the carousel frame edge-to-edge (so it reads as the same surface
 * as the conversation, under the same brand band):
 *   - LEFT — the brief: title + the admin-authored "about this questionnaire" (markdown, optionally
 *     cohort-overridden). Scrolls independently when long.
 *   - RIGHT — what to expect: derived guidance (how it works, what you'll get, good to know).
 *     Scrolls independently when long.
 *   - FOOTER — the proceed CTA, pinned outside both scroll regions so it is ALWAYS visible: a long
 *     brief can never push it below the fold. Reads "Continue" once the respondent has actually made
 *     progress (≥1 answer captured) — e.g. someone who slid back to re-read it mid-run — else the
 *     admin/derived begin label. A merely-opened session at 0% still reads "Begin".
 *
 * Inherits the client's brand via the page's `BrandThemeProvider` CSS vars (`--app-accent-color`,
 * `--app-cta-color`, `--app-cta-gradient`), so it reads as the client's own surface. Pressing the
 * CTA (`onProceed`) slides to the conversation and tells the workspace the session has started,
 * which releases the deferred first LLM turn.
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
  Undo2,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import { IntroVideo } from '@/components/app/questionnaire/intro/intro-video';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_SOFT =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)';
const ACCENT_PANEL =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 5%, transparent)';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 20%, transparent)';
const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

// A faint monochrome grain, baked once as a data URI — depth over the flat card without tinting.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export interface QuestionnaireSplashProps {
  intro: ResolvedSessionIntro;
  /**
   * Has the respondent made progress (≥1 answer captured)? When true the CTA reads "Continue"
   * rather than the begin label — for someone re-reading the intro mid-run or resuming a partly-done
   * session. A freshly-opened session still at 0% reads the begin label, even though the workspace
   * already considers it "started" internally (that only governs the deferred kickoff).
   */
  inProgress?: boolean;
  /** Slide to the conversation and begin (the parent {@link SessionWorkspace} owns the swap). */
  onProceed: () => void;
  className?: string;
}

export function QuestionnaireSplash({
  intro,
  inProgress = false,
  onProceed,
  className,
}: QuestionnaireSplashProps) {
  const { copy, background, questionnaireTitle, videoUrl } = intro;
  const hasBackground = background.trim().length > 0;

  // Ordered, present-only guidance sections (report off → no "what you'll get").
  const sections = useMemo(() => {
    const list: { key: string; icon: LucideIcon; heading: string; body: string }[] = [
      { key: 'how', icon: MessageSquareText, ...copy.howItWorks },
    ];
    if (copy.whatYouGet) {
      list.push({ key: 'get', icon: Sparkles, ...copy.whatYouGet });
    }
    return list;
  }, [copy]);

  const reveal =
    'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500';

  const ctaLabel = inProgress ? 'Continue' : copy.buttonLabel;

  return (
    <div className={cn('h-full min-h-0', className)}>
      <article
        className="bg-card relative flex h-full flex-col overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_50px_-22px_rgba(0,0,0,0.2)]"
        aria-labelledby="intro-title"
      >
        {/* Brand accent ribbon + a near-invisible grain for depth. */}
        <span aria-hidden className="block h-1 w-full shrink-0" style={{ background: CTA_FILL }} />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-multiply dark:opacity-[0.05] dark:mix-blend-screen"
          style={{ backgroundImage: GRAIN, backgroundSize: '140px 140px' }}
        />

        {/* Body — one scroll on mobile, two independently-scrolling panels on lg. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:overflow-hidden">
          {/* LEFT — the brief. */}
          <section
            className={cn(
              'flex flex-col gap-5 px-7 py-8 sm:px-10 lg:min-h-0 lg:overflow-y-auto',
              reveal
            )}
            style={{ animationFillMode: 'both' }}
            aria-label="About this questionnaire"
          >
            <header className="flex flex-col gap-3">
              <span
                className="inline-flex w-fit items-center gap-2 text-[0.7rem] font-semibold tracking-[0.18em] uppercase"
                style={{ color: ACCENT }}
              >
                <span
                  aria-hidden
                  className="h-px w-6"
                  style={{ background: `linear-gradient(to right, ${ACCENT}, transparent)` }}
                />
                Before you begin
              </span>
              <h1
                id="intro-title"
                className="text-foreground text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-[2.4rem]"
              >
                {questionnaireTitle}
              </h1>
            </header>

            {/* Optional intro video — grouped with the about text; self-hides when unset/unresolvable. */}
            <IntroVideo url={videoUrl} />

            {hasBackground ? (
              <div className="flex flex-col gap-2.5">
                <h2 className="text-muted-foreground flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
                  About this questionnaire
                </h2>
                <div
                  className="relative overflow-hidden rounded-2xl border py-5 pr-6 pl-7"
                  style={{ borderColor: ACCENT_HAIRLINE, backgroundColor: ACCENT_SOFT }}
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-4 left-2.5 w-[3px] rounded-full"
                    style={{ background: CTA_FILL }}
                  />
                  <div className="prose prose-sm dark:prose-invert text-foreground/90 prose-p:leading-relaxed max-w-none">
                    <Markdown>{background}</Markdown>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground max-w-prose text-[0.95rem] leading-relaxed text-pretty">
                What this is about, and how it works — so the conversation starts on your terms.
              </p>
            )}
          </section>

          {/* RIGHT — what to expect. A subtly tinted sidebar so it reads as the practical panel. */}
          <section
            className={cn(
              'flex flex-col gap-6 border-t px-7 py-8 sm:px-10 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l',
              reveal
            )}
            style={{
              backgroundColor: ACCENT_PANEL,
              borderColor: 'color-mix(in srgb, var(--color-border) 70%, transparent)',
              animationDelay: '90ms',
              animationFillMode: 'both',
            }}
            aria-label="What to expect"
          >
            <h2 className="text-muted-foreground flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
              What to expect
            </h2>

            <div className="flex flex-col gap-6">
              {sections.map((section) => (
                <div key={section.key} className="flex items-start gap-4">
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
                    <h3 className="text-foreground text-[0.95rem] font-semibold tracking-tight">
                      {section.heading}
                    </h3>
                    <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                      {section.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {copy.goodToKnow.length > 0 && (
              <div className="bg-card/60 rounded-2xl border px-5 py-4 backdrop-blur-[1px]">
                <h3 className="text-muted-foreground mb-3 flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
                  <Info className="h-3.5 w-3.5" style={{ color: ACCENT }} aria-hidden="true" />
                  Good to know
                </h3>
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
              </div>
            )}
          </section>
        </div>

        {/* FOOTER — the CTA, pinned outside both scroll regions so it's always visible. A soft
            top wash lifts it off the body; the proceed button right-aligns under the panel on lg. */}
        <footer
          className="relative shrink-0 border-t px-7 py-2.5 sm:px-10"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-border) 70%, transparent)',
            backgroundColor: ACCENT_PANEL,
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-black/[0.04] to-transparent dark:from-black/20"
          />
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              You can return to this overview anytime.
            </p>
            <button
              type="button"
              onClick={onProceed}
              className="group focus-visible:ring-ring relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_-14px_rgba(0,0,0,0.55)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:translate-y-0 active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none sm:w-auto"
              style={{ background: CTA_FILL }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent"
              />
              <span className="relative">{ctaLabel}</span>
              <ArrowRight
                className="relative h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </button>
          </div>
        </footer>
      </article>
    </div>
  );
}
