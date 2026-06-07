/**
 * DEMO-ONLY (F3.4 gap-fill): visual preview of a demo client's configured brand.
 *
 * An admin sets four theme fields on a demo client (CTA colour, accent colour, logo
 * URL, welcome copy) but the admin UI never showed them back — there was no visual
 * confirmation of what the prospect will see. This renders that brand: colour swatches,
 * a logo thumbnail, and (in full mode) the welcome copy.
 *
 * Reuses the theming module rather than re-deriving anything: `resolveTheme()` fills
 * nulls with the Sunrise defaults, and the logo thumbnail uses the same escaped
 * `--app-logo-url` background approach as {@link BrandThemeProvider} (never a raw
 * `<img src>`), keeping that sink's CSS-injection hardening.
 *
 * Two modes:
 *  - `compact` (table rows): show a swatch / thumbnail only for fields the client has
 *    *actually configured* (non-null) — "once they've been configured"; an unthemed
 *    client renders a muted "Default".
 *  - full (detail page): the resolved brand the respondent will see — both colour
 *    swatches with their hex, the logo (or "No logo"), and the welcome copy.
 *
 * Pure presentational, no client-only APIs, so it renders in both the server detail
 * page and the `'use client'` table/form. A fork that strips demo tenancy drops it.
 */

import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import {
  resolveTheme,
  themeToCssVariables,
  type DemoClientTheme,
} from '@/lib/app/questionnaire/theming';

interface DemoClientThemePreviewProps {
  /** The four nullable theme columns (a `DemoClientView` is structurally compatible). */
  theme: DemoClientTheme;
  /** Table-row variant: configured fields only, no labels. */
  compact?: boolean;
  className?: string;
}

function Swatch({ color, label, compact }: { color: string; label?: string; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('inline-block rounded-full border', compact ? 'h-4 w-4' : 'h-5 w-5')}
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {label && <span className="text-muted-foreground font-mono text-xs">{label}</span>}
    </span>
  );
}

function LogoThumb({ logoUrl, compact }: { logoUrl: string; compact?: boolean }) {
  // Reuse the escaped url("…") the theming sink produces, applied as a background so a
  // hostile stored value can't break out of url() (mirrors BrandThemeProvider).
  const style = themeToCssVariables({
    ctaColor: '',
    accentColor: '',
    logoUrl,
    welcomeCopy: '',
  }) as CSSProperties;
  return (
    <span
      role="img"
      aria-label="Brand logo"
      className={cn('bg-contain bg-center bg-no-repeat', compact ? 'h-5 w-12' : 'h-8 w-32')}
      style={{ backgroundImage: 'var(--app-logo-url)', ...style }}
    />
  );
}

export function DemoClientThemePreview({
  theme,
  compact = false,
  className,
}: DemoClientThemePreviewProps) {
  const configured =
    theme.ctaColor !== null ||
    theme.accentColor !== null ||
    theme.logoUrl !== null ||
    theme.welcomeCopy !== null;

  // Compact (table): show only what the admin actually configured.
  if (compact) {
    if (!configured) {
      return <span className="text-muted-foreground text-xs">Default</span>;
    }
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        {theme.ctaColor && <Swatch color={theme.ctaColor} compact />}
        {theme.accentColor && <Swatch color={theme.accentColor} compact />}
        {theme.logoUrl && <LogoThumb logoUrl={theme.logoUrl} compact />}
        {!theme.ctaColor && !theme.accentColor && !theme.logoUrl && (
          // Only welcome copy is set — nothing visual to swatch.
          <span className="text-muted-foreground text-xs">Welcome copy</span>
        )}
      </span>
    );
  }

  // Full (detail / live preview): the resolved brand the respondent will see.
  const resolved = resolveTheme(theme);
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-6">
        <Swatch color={resolved.ctaColor} label={`CTA ${resolved.ctaColor}`} />
        <Swatch color={resolved.accentColor} label={`Accent ${resolved.accentColor}`} />
        <span className="inline-flex items-center gap-2">
          {resolved.logoUrl ? (
            <LogoThumb logoUrl={resolved.logoUrl} />
          ) : (
            <span className="text-muted-foreground text-xs">No logo</span>
          )}
        </span>
      </div>
      <p className="text-muted-foreground text-sm italic">&ldquo;{resolved.welcomeCopy}&rdquo;</p>
      {!configured && (
        <p className="text-muted-foreground text-xs">
          Nothing configured — these are the Sunrise defaults.
        </p>
      )}
    </div>
  );
}
