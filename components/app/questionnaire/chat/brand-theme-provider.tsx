/**
 * DEMO-ONLY (F7.1+): apply a resolved demo-client brand theme to the chat surface.
 *
 * Spreads the theming module's CSS custom properties (`--app-cta-color`, `--app-accent-color`,
 * `--app-cta-gradient`, and — when set — `--app-surface-color`, `--app-logo-bg`, `--app-logo-url`)
 * onto a wrapper so the chat component's accent/CTA colours pick up the brand with no prop
 * drilling. When the client sets a surface colour, the brand renders a coloured header band
 * carrying the logo (left-aligned, like a site header); otherwise the logo sits centred on the
 * plain chrome, exactly as before. The logo is painted via the escaped `--app-logo-url`
 * background (never a raw `<img src>`), optionally on the resolved `--app-logo-bg` backdrop —
 * for logos drawn to sit on one specific brand colour.
 *
 * A fork that strips demo tenancy renders children directly and drops this wrapper.
 */

import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { themeToCssVariables, type ResolvedTheme } from '@/lib/app/questionnaire/theming';

interface BrandThemeProviderProps {
  theme: ResolvedTheme;
  className?: string;
  children: React.ReactNode;
}

/**
 * The logo itself (escaped `url()` background). When a backdrop is resolved it's wrapped
 * in a padded panel of that colour — a logo chip that reads on any surface. `onSurface`
 * left-aligns it (a header-band logo); otherwise it's centred.
 */
function LogoMark({ onSurface, hasBackdrop }: { onSurface: boolean; hasBackdrop: boolean }) {
  const logo = (
    <span
      role="img"
      aria-label="Brand logo"
      className={cn('block h-8 w-40 bg-contain bg-no-repeat', onSurface ? 'bg-left' : 'bg-center')}
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

export function BrandThemeProvider({ theme, className, children }: BrandThemeProviderProps) {
  const style = themeToCssVariables(theme) as CSSProperties;
  const hasSurface = Boolean(theme.surfaceColor);
  const hasBackdrop = Boolean(theme.logoBackgroundColor);
  // A header band is worth rendering when there's a surface colour or a logo to carry.
  const showBand = hasSurface || Boolean(theme.logoUrl);

  return (
    // `data-surface="respondent"` re-scopes the central questionnaire area to a
    // NEUTRAL canvas (see app/brand-theme.css): the consumer ConQuest brand
    // (cream / Fraunces) stops here, so the demo client's own `--app-*` brand is
    // the only identity inside, while the surrounding header / footer / cookie
    // modal stay ConQuest. Renders identically live (/q) and logged-in
    // (/questionnaires) since both wrap their chat in this provider.
    <div data-surface="respondent" style={style} className={cn('flex h-full flex-col', className)}>
      {showBand && (
        <div
          className={cn(
            'flex shrink-0 items-center',
            hasSurface ? 'justify-start px-4 py-3 sm:px-6' : 'justify-center py-3'
          )}
          style={hasSurface ? { backgroundColor: 'var(--app-surface-color)' } : undefined}
        >
          {theme.logoUrl ? (
            <LogoMark onSurface={hasSurface} hasBackdrop={hasBackdrop} />
          ) : (
            // Surface-only brand (no logo): a slim band still anchors the experience.
            <span aria-hidden className="h-2 w-2" />
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
