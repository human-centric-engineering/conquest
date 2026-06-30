/**
 * DEMO-ONLY (F7.1+): apply a resolved demo-client brand theme to the chat surface, and render
 * the respondent header band above the conversation.
 *
 * Spreads the theming module's CSS custom properties (`--app-cta-color`, `--app-accent-color`,
 * `--app-cta-gradient`, and — when set — `--app-surface-color`, `--app-on-surface`,
 * `--app-logo-bg`, `--app-logo-url`) onto a wrapper so the chat component's accent/CTA colours
 * pick up the brand with no prop drilling.
 *
 * The band is a three-zone header — Brand · Title · Schedule:
 *  - Brand: the client logo (escaped `--app-logo-url` background, never a raw `<img src>`),
 *    optionally on the resolved `--app-logo-bg` backdrop chip.
 *  - Title: the questionnaire title, with the round name as a small eyebrow above it. Takes the
 *    slack (`flex-1`) and truncates — this is the real estate the logo used to leave empty.
 *  - Schedule: a status pill (live Open / Closing soon / Opens / Closed dot) over the round's
 *    date window. Omitted for open-ended sessions; hidden on narrow screens (title takes priority).
 *
 * On a coloured surface the band paints `--app-surface-color` and uses `--app-on-surface` for
 * contrast-correct text; with no surface it sits on the neutral respondent canvas with a hairline
 * underline. Either way text uses `currentColor` with opacity for muted/secondary content, so a
 * single resolved colour drives the whole band.
 *
 * `header` is optional: without it (or without a title) the band degrades to logo-only, exactly as
 * before. A fork that strips demo tenancy renders children directly and drops this wrapper.
 */

import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { themeToCssVariables, type ResolvedTheme } from '@/lib/app/questionnaire/theming';
import { buildScheduleView, type ScheduleStatus } from '@/lib/app/questionnaire/header/schedule';
import type { BandHeader } from '@/lib/app/questionnaire/header/types';

interface BrandThemeProviderProps {
  theme: ResolvedTheme;
  /** Title + round window shown in the band. Absent → logo-only band (legacy behaviour). */
  header?: BandHeader | null;
  className?: string;
  children: React.ReactNode;
}

/** Status → dot colour. Fixed semantic hues read on both light and dark brand surfaces; a closed
 * round uses muted `currentColor` so it recedes. */
const STATUS_DOT: Record<ScheduleStatus, string> = {
  open: 'bg-emerald-500',
  'closing-soon': 'bg-amber-500',
  upcoming: 'bg-sky-500',
  closed: 'bg-current opacity-40',
};

/**
 * The logo itself (escaped `url()` background, left-aligned). When a backdrop is resolved it's
 * wrapped in a padded panel of that colour — a logo chip that reads on any surface. Sized down a
 * step on mobile so the title + schedule have room.
 */
function LogoMark({ hasBackdrop }: { hasBackdrop: boolean }) {
  const logo = (
    <span
      role="img"
      aria-label="Brand logo"
      className="block h-8 w-36 bg-contain bg-left bg-no-repeat sm:h-10 sm:w-48"
      style={{ backgroundImage: 'var(--app-logo-url)' }}
    />
  );
  if (!hasBackdrop) return logo;
  return (
    <span className="inline-flex rounded-md p-2" style={{ backgroundColor: 'var(--app-logo-bg)' }}>
      {logo}
    </span>
  );
}

export function BrandThemeProvider({
  theme,
  header,
  className,
  children,
}: BrandThemeProviderProps) {
  const style = themeToCssVariables(theme) as CSSProperties;
  const hasSurface = Boolean(theme.surfaceColor);
  const hasBackdrop = Boolean(theme.logoBackgroundColor);
  const hasLogo = Boolean(theme.logoUrl);

  const title = header?.title?.trim() ?? '';
  const round = header?.round ?? null;
  // SSR-computed against the render-time clock: a day-granularity window, fresh enough for a header.
  const schedule = round ? buildScheduleView(round, new Date()) : null;

  // Worth a band when there's a surface to paint, a logo to carry, or a title to show.
  const showBand = hasSurface || hasLogo || Boolean(title);

  return (
    // `data-surface="respondent"` re-scopes the central questionnaire area to a
    // NEUTRAL canvas (see app/brand-theme.css): the consumer ConQuest brand
    // (cream / Fraunces) stops here, so the demo client's own `--app-*` brand is
    // the only identity inside, while the surrounding header / footer / cookie
    // modal stay ConQuest. Renders identically live (/q) and logged-in
    // (/questionnaires) since both wrap their chat in this provider.
    <div data-surface="respondent" style={style} className={cn('flex h-full flex-col', className)}>
      {showBand && (
        <header
          className={cn(
            'flex shrink-0 items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6',
            // No surface → sit on the neutral canvas with a hairline rule to separate the band.
            !hasSurface && 'border-b border-current/10'
          )}
          style={
            hasSurface
              ? { backgroundColor: 'var(--app-surface-color)', color: 'var(--app-on-surface)' }
              : undefined
          }
        >
          {hasLogo && <LogoMark hasBackdrop={hasBackdrop} />}
          {hasLogo && title && (
            <span aria-hidden className="hidden h-8 w-px shrink-0 bg-current/15 sm:block" />
          )}

          {/* Title zone — absorbs the slack, truncates. Empty (just a spacer) for a logo-only band. */}
          <div className="flex min-w-0 flex-1 flex-col">
            {round?.name && (
              <span className="truncate text-[11px] font-semibold tracking-[0.08em] uppercase opacity-60">
                {round.name}
              </span>
            )}
            {title && (
              <p
                className={cn(
                  'truncate leading-tight font-semibold',
                  hasLogo ? 'text-sm sm:text-base' : 'text-base sm:text-lg'
                )}
              >
                {title}
              </p>
            )}
          </div>

          {/* Schedule zone — hidden on narrow screens so the title keeps priority. */}
          {schedule && (
            <div className="hidden shrink-0 flex-col items-end leading-tight sm:flex">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase opacity-70">
                <span
                  aria-hidden
                  className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[schedule.status])}
                />
                {schedule.statusLabel}
              </span>
              {schedule.dateRange && (
                <span className="text-xs font-medium tabular-nums opacity-90">
                  {schedule.dateRange}
                </span>
              )}
            </div>
          )}
        </header>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
