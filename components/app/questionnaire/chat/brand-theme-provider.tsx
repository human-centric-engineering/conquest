/**
 * DEMO-ONLY (F7.1): apply a resolved demo-client brand theme to the chat surface.
 *
 * Spreads the theming module's CSS custom properties (`--app-cta-color`, `--app-accent-color`,
 * and — when set — `--app-logo-url`) onto a wrapper so the chat component's accent/CTA colours
 * pick up the brand with no prop drilling. Renders the brand logo (via the escaped
 * `--app-logo-url` background, never a raw `<img src>`) above the conversation when present.
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

export function BrandThemeProvider({ theme, className, children }: BrandThemeProviderProps) {
  const style = themeToCssVariables(theme) as CSSProperties;

  return (
    <div style={style} className={cn('flex h-full flex-col', className)}>
      {theme.logoUrl && (
        <div className="flex shrink-0 justify-center py-3">
          <div
            role="img"
            aria-label="Brand logo"
            className="h-8 w-40 bg-contain bg-center bg-no-repeat"
            style={{ backgroundImage: 'var(--app-logo-url)' }}
          />
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
