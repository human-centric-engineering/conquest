// @vitest-environment happy-dom

/**
 * DemoClientThemePreview — admin-facing visual preview of a demo client's brand.
 *
 * compact mode shows only configured fields ("once they've been configured"); full
 * mode shows the resolved brand (defaults filled). Logo uses an escaped `url()`
 * background, never a raw <img src>.
 *
 * @see components/admin/demo-clients/demo-client-theme-preview.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import { CONQUEST_THEME_DEFAULTS, type DemoClientTheme } from '@/lib/app/questionnaire/theming';

const UNCONFIGURED: DemoClientTheme = {
  ctaColor: null,
  accentColor: null,
  logoUrl: null,
  welcomeCopy: null,
};

function logoBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[aria-label="Brand logo"]');
}

describe('DemoClientThemePreview — compact (table)', () => {
  it('renders a muted "Default" when nothing is configured', () => {
    render(<DemoClientThemePreview theme={UNCONFIGURED} compact />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('renders a swatch for each configured colour and the logo thumbnail', () => {
    const { container } = render(
      <DemoClientThemePreview
        theme={{
          ctaColor: '#112233',
          accentColor: '#445566',
          logoUrl: 'https://example.com/logo.png',
          welcomeCopy: null,
        }}
        compact
      />
    );
    // two colour swatches (bordered round spans) carry the raw hex as a background
    const swatches = container.querySelectorAll('span[style*="background-color"]');
    expect(swatches).toHaveLength(2);
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe('#112233');

    const logo = logoBox(container);
    expect(logo).not.toBeNull();
    expect((logo as HTMLElement).style.backgroundImage).toBe('url("https://example.com/logo.png")');
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });

  it('shows a "Welcome copy" hint when only welcome copy is configured (nothing to swatch)', () => {
    const { container } = render(
      <DemoClientThemePreview
        theme={{ ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: 'Hi there' }}
        compact
      />
    );
    expect(screen.getByText('Welcome copy')).toBeInTheDocument();
    expect(container.querySelectorAll('span[style*="background-color"]')).toHaveLength(0);
    expect(logoBox(container)).toBeNull();
  });
});

describe('DemoClientThemePreview — full (detail / live preview)', () => {
  it('renders the resolved cta/accent hex and welcome copy, with "No logo" when unset', () => {
    render(<DemoClientThemePreview theme={UNCONFIGURED} />);

    // ConQuest defaults fill the gaps.
    expect(screen.getByText(`CTA ${CONQUEST_THEME_DEFAULTS.ctaColor}`)).toBeInTheDocument();
    expect(screen.getByText(`Accent ${CONQUEST_THEME_DEFAULTS.accentColor}`)).toBeInTheDocument();
    expect(screen.getByText(`“${CONQUEST_THEME_DEFAULTS.welcomeCopy}”`)).toBeInTheDocument();
    expect(screen.getByText('No logo')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing configured — this questionnaire runs in ConQuest colours.')
    ).toBeInTheDocument();
  });

  it('renders the configured logo thumbnail and drops the defaults hint', () => {
    const { container } = render(
      <DemoClientThemePreview
        theme={{
          ctaColor: '#abcdef',
          accentColor: null,
          logoUrl: 'https://example.com/brand.svg',
          welcomeCopy: 'Welcome aboard',
        }}
      />
    );
    expect(screen.getByText('CTA #abcdef')).toBeInTheDocument();
    // accentColor null → resolved to the ConQuest default
    expect(screen.getByText(`Accent ${CONQUEST_THEME_DEFAULTS.accentColor}`)).toBeInTheDocument();
    expect(screen.getByText('“Welcome aboard”')).toBeInTheDocument();
    expect((logoBox(container) as HTMLElement).style.backgroundImage).toBe(
      'url("https://example.com/brand.svg")'
    );
    expect(screen.queryByText('No logo')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Nothing configured — this questionnaire runs in ConQuest colours.')
    ).not.toBeInTheDocument();
  });
});

describe('the preview declares itself a respondent surface', () => {
  // Not decoration. Three things the preview shows are produced by app/brand-theme.css rules
  // scoped to `[data-surface='respondent']`: the client's ground per mode, the DERIVED dark
  // canvas (which an admin would otherwise never see, since the resolver cannot know the mode),
  // and the ConQuest fallback palette for an unbranded client. Without the markers the preview
  // has to fake all three, which is how it ended up with a hand-written `var(a, var(b, var(c)))`
  // chain on the send button.

  /**
   * One of the two panels. Full mode renders the miniature twice — once pinned to each mode — so
   * every assertion below has to say which it means; `light` is the arbitrary default because the
   * markers under test are identical on both.
   */
  function previewRoot(container: HTMLElement, scheme: 'light' | 'dark' = 'light'): HTMLElement {
    const node = container.querySelector(`[aria-label="Session preview, ${scheme} mode"]`);
    expect(node).not.toBeNull();
    return node as HTMLElement;
  }

  /** The lockup drawn in one panel's header band (the swatch-row thumbnails sit outside both). */
  function bandLogo(container: HTMLElement, scheme: 'light' | 'dark'): HTMLElement {
    const node = previewRoot(container, scheme).querySelector('[aria-label="Brand logo"]');
    expect(node).not.toBeNull();
    return node as HTMLElement;
  }

  it('marks the miniature as a respondent surface', () => {
    const { container } = render(<DemoClientThemePreview theme={{ ...UNCONFIGURED }} />);
    expect(previewRoot(container).dataset.surface).toBe('respondent');
  });

  it('claims the ConQuest brand only when the client has no identity of their own', () => {
    const { container: unbranded } = render(<DemoClientThemePreview theme={{ ...UNCONFIGURED }} />);
    expect(previewRoot(unbranded).dataset.brand).toBe('conquest');

    const { container: branded } = render(
      <DemoClientThemePreview theme={{ ...UNCONFIGURED, ctaColor: '#ff0000' }} />
    );
    expect(previewRoot(branded).dataset.brand).toBeUndefined();
  });

  it("flags a client canvas so the palette is re-derived from the client's ground", () => {
    const { container: plain } = render(<DemoClientThemePreview theme={{ ...UNCONFIGURED }} />);
    expect(previewRoot(plain).dataset.canvas).toBeUndefined();

    const { container: grounded } = render(
      <DemoClientThemePreview theme={{ ...UNCONFIGURED, canvasColor: '#0b1f3a' }} />
    );
    expect(previewRoot(grounded).dataset.canvas).toBe('custom');
  });

  it('carries both ground variables, so the mode in force decides which applies', () => {
    const { container } = render(
      <DemoClientThemePreview theme={{ ...UNCONFIGURED, canvasColor: '#f5f9ff' }} />
    );
    const root = previewRoot(container);
    expect(root.style.getPropertyValue('--app-canvas-light')).toBe('#f5f9ff');
    // Derived — the admin never typed this, and it is the whole reason the dark panel is worth
    // rendering at all.
    expect(root.style.getPropertyValue('--app-canvas-dark')).not.toBe('');
  });

  it('renders both modes at once, each pinned so it cannot follow the admin’s own', () => {
    // Every other respondent surface follows <html>.dark, which two panels on one page cannot
    // both do. `data-scheme` is what app/brand-theme.css reads to override that.
    const { container } = render(<DemoClientThemePreview theme={{ ...UNCONFIGURED }} />);

    expect(previewRoot(container, 'light').dataset.scheme).toBe('light');
    expect(previewRoot(container, 'dark').dataset.scheme).toBe('dark');
  });

  it('paints each panel’s band with the lockup resolved for THAT panel’s ground', () => {
    // The regression this exists for: both panels read `bandLogoUrl` — the lockup chosen for the
    // LIGHT ground — so an admin who supplied a light-on-dark logo saw their dark artwork nowhere
    // in the preview, and the dark panel showed the dark-ink lockup sunk into a dark canvas.
    const { container } = render(
      <DemoClientThemePreview
        theme={{
          ...UNCONFIGURED,
          canvasColor: '#f8f2ec',
          logoUrl: 'https://example.com/logo.svg',
          logoDarkUrl: 'https://example.com/logo-light.svg',
        }}
      />
    );

    expect(bandLogo(container, 'light').style.backgroundImage).toBe(
      'url("https://example.com/logo.svg")'
    );
    expect(bandLogo(container, 'dark').style.backgroundImage).toBe(
      'url("https://example.com/logo-light.svg")'
    );
  });

  it('falls back to the standard lockup in dark mode when no dark one is supplied', () => {
    // A client with one piece of artwork keeps it in both panels — the fallback the resolver
    // already makes, asserted here so the per-panel choice above cannot regress into "dark panel
    // shows nothing".
    const { container } = render(
      <DemoClientThemePreview
        theme={{
          ...UNCONFIGURED,
          canvasColor: '#f8f2ec',
          logoUrl: 'https://example.com/logo.svg',
        }}
      />
    );

    expect(bandLogo(container, 'dark').style.backgroundImage).toBe(
      'url("https://example.com/logo.svg")'
    );
  });

  it('gives both panels the same brand, so only the mode differs between them', () => {
    // The panels are one client rendered twice. If they ever disagreed about anything but the
    // mode, the comparison the admin is making would be meaningless.
    const { container } = render(
      <DemoClientThemePreview theme={{ ...UNCONFIGURED, canvasColor: '#0b1f3a' }} />
    );

    for (const scheme of ['light', 'dark'] as const) {
      const root = previewRoot(container, scheme);
      expect(root.dataset.canvas).toBe('custom');
      expect(root.style.getPropertyValue('--app-canvas-light')).toBe('#0b1f3a');
    }
  });
});
