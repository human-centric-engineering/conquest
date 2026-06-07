/**
 * DemoClientThemePreview — admin-facing visual preview of a demo client's brand.
 *
 * compact mode shows only configured fields ("once they've been configured"); full
 * mode shows the resolved brand (defaults filled). Logo uses the escaped
 * `--app-logo-url` background, never a raw <img src>.
 *
 * @see components/admin/demo-clients/demo-client-theme-preview.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import { SUNRISE_THEME_DEFAULTS, type DemoClientTheme } from '@/lib/app/questionnaire/theming';

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
    expect((logo as HTMLElement).style.getPropertyValue('--app-logo-url')).toBe(
      'url("https://example.com/logo.png")'
    );
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

    // Sunrise defaults fill the gaps.
    expect(screen.getByText(`CTA ${SUNRISE_THEME_DEFAULTS.ctaColor}`)).toBeInTheDocument();
    expect(screen.getByText(`Accent ${SUNRISE_THEME_DEFAULTS.accentColor}`)).toBeInTheDocument();
    expect(screen.getByText(`“${SUNRISE_THEME_DEFAULTS.welcomeCopy}”`)).toBeInTheDocument();
    expect(screen.getByText('No logo')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing configured — these are the Sunrise defaults.')
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
    // accentColor null → resolved to the Sunrise default
    expect(screen.getByText(`Accent ${SUNRISE_THEME_DEFAULTS.accentColor}`)).toBeInTheDocument();
    expect(screen.getByText('“Welcome aboard”')).toBeInTheDocument();
    expect((logoBox(container) as HTMLElement).style.getPropertyValue('--app-logo-url')).toBe(
      'url("https://example.com/brand.svg")'
    );
    expect(screen.queryByText('No logo')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Nothing configured — these are the Sunrise defaults.')
    ).not.toBeInTheDocument();
  });
});
