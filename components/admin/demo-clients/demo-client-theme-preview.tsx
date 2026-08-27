/**
 * DEMO-ONLY (F3.4 / F7.1+): visual preview of a demo client's configured brand.
 *
 * An admin sets the theme fields on a demo client (CTA colour, accent colour, logo
 * URL, welcome copy, plus the F7.1+ chrome set: surface colour, CTA gradient end, and
 * a logo backdrop toggle) but the admin UI never showed them back. This renders that
 * brand: colour swatches, a logo thumbnail, the welcome copy, and — in full mode — a
 * miniature of the respondent session chrome so the admin sees, suggestively, what the
 * respondent will see (the same surface band + gradient CTA the session renders).
 *
 * The miniature declares `data-surface='respondent'` on its own root, so it inherits the real
 * surface's palette rules from app/brand-theme.css — which is what lets it show the client's
 * canvas, their DERIVED dark canvas, and the ConQuest fallback without re-implementing any of
 * the three.
 *
 * Reuses the theming module rather than re-deriving anything: `resolveTheme()` fills
 * nulls with the ConQuest defaults (and resolves the logo backdrop), and the logo uses
 * the same escaped `--app-logo-url` background approach as {@link BrandThemeProvider}
 * (never a raw `<img src>`), keeping that sink's CSS-injection hardening.
 *
 * Two modes:
 *  - `compact` (table rows): show a swatch / thumbnail only for fields the client has
 *    *actually configured* (non-null) — an unthemed client renders a muted "Default".
 *  - full (detail page / live form preview): the resolved brand the respondent sees.
 *
 * Pure presentational, no client-only APIs, so it renders in both the server detail
 * page and the `'use client'` table/form. A fork that strips demo tenancy drops it.
 */

import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import {
  FONT_PAIRING_COPY,
  cssUrl,
  resolveTheme,
  themeToCssVariables,
  type DemoClientTheme,
  type ResolvedTheme,
} from '@/lib/app/questionnaire/theming';

interface DemoClientThemePreviewProps {
  /** The nullable theme columns (a `DemoClientView` is structurally compatible). */
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

function LogoThumb({
  logoUrl,
  backdrop,
  compact,
}: {
  logoUrl: string;
  /** Optional solid colour painted behind the logo (resolved logo backdrop). */
  backdrop?: string | null;
  compact?: boolean;
}) {
  // Escape through the shared theming sink so a hostile stored value can't break out of
  // url() (the same helper themeToCssVariables uses for --app-logo-url).
  return (
    <span
      role="img"
      aria-label="Brand logo"
      className={cn(
        'inline-block bg-contain bg-center bg-no-repeat',
        compact ? 'h-5 w-12' : 'h-8 w-32',
        backdrop && 'rounded px-2'
      )}
      style={{
        backgroundImage: cssUrl(logoUrl),
        ...(backdrop ? { backgroundColor: backdrop } : {}),
      }}
    />
  );
}

/**
 * A miniature of the respondent session chrome the F7.1 surface renders: the surface
 * header band (with the logo on its backdrop), a sample assistant/user exchange in the
 * accent colour, and the gradient send button. Suggestive, not pixel-accurate — enough
 * for the admin to recognise the brand before hitting "Preview as respondent".
 */
function ChromePreview({ resolved }: { resolved: ResolvedTheme }) {
  const vars = themeToCssVariables(resolved) as CSSProperties;
  // Text laid on the band uses the contrast-correct on-surface colour the session band uses;
  // with no surface the band sits on the canvas and reads the ink resolved for it.
  const onBand = resolved.surfaceColor ? 'var(--app-on-surface)' : 'var(--app-on-canvas)';
  // The preview declares itself a RESPONDENT SURFACE, with the same two markers the real one
  // carries. That is what makes it faithful rather than approximate:
  //  - the client's ground and ink are chosen per mode by app/brand-theme.css, so the preview
  //    follows the admin's own light/dark exactly as the respondent's page will follow theirs —
  //    including the DERIVED dark canvas, which an admin would otherwise never see;
  //  - `data-brand='conquest'` brings the unbranded palette in, which this preview used to fake
  //    with a hand-written `var(--app-cta-gradient, var(--app-cta-color, …))` fallback chain
  //    because the real block is scoped to a surface the preview was not.
  const canvas = 'var(--app-canvas-color)';
  const ink = 'var(--app-on-canvas)';
  return (
    <div
      data-surface="respondent"
      data-brand={resolved.hasBrandIdentity ? undefined : 'conquest'}
      data-canvas={resolved.canvasColor ? 'custom' : undefined}
      style={{
        ...vars,
        // The type the client chose, applied to the preview so the pairing is legible as a
        // pairing rather than as a word in a dropdown.
        fontFamily: 'var(--app-font-body)',
      }}
      className="overflow-hidden rounded-lg border"
      aria-label="Session preview"
      role="img"
    >
      {/* Surface header band — Brand · Title · Schedule, mirroring the respondent band.
          Falls back to a muted strip when no surface is set; sample title/dates are illustrative. */}
      <div
        className="flex items-center gap-2.5 px-3 py-2.5"
        style={{ backgroundColor: resolved.surfaceColor ?? 'var(--color-muted)', color: onBand }}
      >
        {resolved.bandLogoUrl && (
          <LogoThumb logoUrl={resolved.bandLogoUrl} backdrop={resolved.logoBackgroundColor} />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">Question session</span>
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium opacity-80">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="tabular-nums">1–30 Jun</span>
        </span>
      </div>

      {/* Body: a sample assistant line + a user bubble tinted with the accent, on the client's
          own ground. The heading line is real type rather than a grey bar, because it is the
          only way the display face of the pairing shows up in the preview at all. */}
      <div className="space-y-2 px-3 py-3" style={{ backgroundColor: canvas, color: ink }}>
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: resolved.accentColor }}
          />
          <span
            className="text-[11px] leading-tight font-semibold"
            style={{ fontFamily: 'var(--app-font-display)' }}
          >
            A question, set in this type
          </span>
        </div>
        <div className="flex justify-end">
          <span
            className="rounded-lg rounded-br-sm px-3 py-1.5 text-[11px] text-transparent"
            style={{
              backgroundColor: `color-mix(in srgb, ${resolved.accentColor} 14%, transparent)`,
            }}
          >
            Your answer
          </span>
        </div>
      </div>

      {/* Composer: input + the gradient (or solid) send button, on the same ground. */}
      <div
        className="flex items-center gap-2 border-t px-3 py-2"
        style={{ backgroundColor: canvas }}
      >
        <span
          className="h-6 flex-1 rounded-md"
          style={{ backgroundColor: `color-mix(in srgb, ${ink} 8%, transparent)` }}
        />
        <span
          className="inline-flex h-6 w-9 items-center justify-center rounded-md text-[10px] font-semibold"
          // Exactly what the respondent CTA reads, with no fallback chain of its own: the
          // preview now IS a respondent surface (see the root above), so the mode-aware
          // `[data-brand='conquest']` block fills these for an unbranded client — including
          // `--app-on-cta`, which is why the foreground is no longer a hardcoded white that
          // failed on the gold dark-mode CTA.
          style={{
            background: 'var(--app-cta-gradient)',
            color: 'var(--app-on-cta)',
          }}
        >
          →
        </span>
      </div>
    </div>
  );
}

export function DemoClientThemePreview({
  theme,
  compact = false,
  className,
}: DemoClientThemePreviewProps) {
  // Truthiness (not `!== null`): the F7.1+ chrome fields are optional on the raw theme
  // contract, so an unconfigured client passes them as `undefined`, not `null`.
  const configured =
    Boolean(theme.canvasColor) ||
    Boolean(theme.inkColor) ||
    Boolean(theme.accentColorEnd) ||
    Boolean(theme.logoMarkUrl) ||
    Boolean(theme.logoDarkUrl) ||
    Boolean(theme.fontPairing) ||
    Boolean(theme.ctaColor) ||
    Boolean(theme.accentColor) ||
    Boolean(theme.logoUrl) ||
    Boolean(theme.bannerUrl) ||
    Boolean(theme.welcomeCopy) ||
    Boolean(theme.surfaceColor) ||
    Boolean(theme.ctaColorEnd) ||
    Boolean(theme.logoBackgroundColor) ||
    Boolean(theme.logoBackgroundEnabled);

  // Compact (table): show only what the admin actually configured.
  if (compact) {
    if (!configured) {
      return <span className="text-muted-foreground text-xs">Default</span>;
    }
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        {theme.canvasColor && <Swatch color={theme.canvasColor} compact />}
        {theme.surfaceColor && <Swatch color={theme.surfaceColor} compact />}
        {theme.ctaColor && <Swatch color={theme.ctaColor} compact />}
        {theme.ctaColorEnd && <Swatch color={theme.ctaColorEnd} compact />}
        {theme.accentColor && <Swatch color={theme.accentColor} compact />}
        {theme.logoUrl && <LogoThumb logoUrl={theme.logoUrl} compact />}
        {!theme.ctaColor &&
          !theme.accentColor &&
          !theme.logoUrl &&
          !theme.surfaceColor &&
          !theme.ctaColorEnd &&
          !theme.canvasColor && (
            // Only welcome copy / logo toggle is set — nothing visual to swatch.
            <span className="text-muted-foreground text-xs">Welcome copy</span>
          )}
      </span>
    );
  }

  // Full (detail / live preview): the resolved brand the respondent will see.
  const resolved = resolveTheme(theme);
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {resolved.canvasColor && (
          <Swatch color={resolved.canvasColor} label={`Canvas ${resolved.canvasColor}`} />
        )}
        {resolved.surfaceColor && (
          <Swatch color={resolved.surfaceColor} label={`Surface ${resolved.surfaceColor}`} />
        )}
        <Swatch
          color={resolved.ctaColor}
          label={
            resolved.ctaColorEnd
              ? `CTA ${resolved.ctaColor} → ${resolved.ctaColorEnd}`
              : `CTA ${resolved.ctaColor}`
          }
        />
        <Swatch
          color={resolved.accentColor}
          label={
            resolved.accentColorEnd
              ? `Accent ${resolved.accentColor} → ${resolved.accentColorEnd}`
              : `Accent ${resolved.accentColor}`
          }
        />
        <span className="inline-flex items-center gap-2">
          {resolved.logoUrl ? (
            <LogoThumb logoUrl={resolved.logoUrl} backdrop={resolved.logoBackgroundColor} />
          ) : (
            <span className="text-muted-foreground text-xs">No logo</span>
          )}
        </span>
        {/* The dark lockup is shown ON a dark chip — the only way to see whether it is
            actually the light-ink artwork rather than a second copy of the standard one. */}
        {resolved.logoDarkUrl && (
          <span className="inline-flex items-center gap-2">
            <LogoThumb logoUrl={resolved.logoDarkUrl} backdrop="#18181b" />
            <span className="text-muted-foreground text-xs">on dark</span>
          </span>
        )}
        {resolved.logoMarkUrl && (
          <span
            role="img"
            aria-label="Brand mark"
            className="inline-block h-8 w-8 bg-contain bg-center bg-no-repeat"
            style={{ backgroundImage: cssUrl(resolved.logoMarkUrl) }}
          />
        )}
        <span className="text-muted-foreground text-xs">
          {FONT_PAIRING_COPY[resolved.fontPairing].label} type
        </span>
      </div>

      <ChromePreview resolved={resolved} />

      <p className="text-muted-foreground text-sm italic">&ldquo;{resolved.welcomeCopy}&rdquo;</p>
      {!configured && (
        <p className="text-muted-foreground text-xs">
          Nothing configured — this questionnaire runs in ConQuest colours.
        </p>
      )}
    </div>
  );
}
