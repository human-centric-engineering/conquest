/**
 * BrandThemeProvider — projects a resolved theme onto CSS custom properties + logo.
 *
 * @see components/app/questionnaire/chat/brand-theme-provider.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type { BandHeader } from '@/lib/app/questionnaire/header/types';

const BASE: ResolvedTheme = {
  ctaColor: '#112233',
  accentColor: '#445566',
  logoUrl: null,
  welcomeCopy: 'hello',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
};

/** A header far enough inside an open window to read "Open · closes in N days". */
function openHeader(over: Partial<BandHeader['round'] & object> = {}): BandHeader {
  // closesAt well in the future so the status is a stable "Open" regardless of when the
  // suite runs (the band computes against the real clock).
  const closesAt = new Date(Date.now() + 5 * 86_400_000);
  return {
    title: 'Customer Experience Survey',
    round: {
      name: 'Round 3 · Spring Cohort',
      status: 'open',
      opensAt: new Date(Date.now() - 5 * 86_400_000),
      closesAt,
      closedAt: null,
      ...over,
    },
  };
}

describe('BrandThemeProvider', () => {
  it('applies the cta + accent colours as CSS custom properties', () => {
    const { container } = render(
      <BrandThemeProvider theme={BASE}>
        <span>child</span>
      </BrandThemeProvider>
    );
    const wrapper = container.firstChild as HTMLElement;

    expect(wrapper.style.getPropertyValue('--app-cta-color')).toBe('#112233');
    expect(wrapper.style.getPropertyValue('--app-accent-color')).toBe('#445566');
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('omits the logo box when no logo is set', () => {
    render(
      <BrandThemeProvider theme={BASE}>
        <span>child</span>
      </BrandThemeProvider>
    );
    expect(screen.queryByRole('img', { name: 'Brand logo' })).not.toBeInTheDocument();
  });

  it('renders the logo box (and sets --app-logo-url) when a logo is set', () => {
    const { container } = render(
      <BrandThemeProvider theme={{ ...BASE, logoUrl: 'https://example.com/logo.png' }}>
        <span>child</span>
      </BrandThemeProvider>
    );
    const wrapper = container.firstChild as HTMLElement;

    expect(screen.getByRole('img', { name: 'Brand logo' })).toBeInTheDocument();
    expect(wrapper.style.getPropertyValue('--app-logo-url')).toBe(
      'url("https://example.com/logo.png")'
    );
  });

  describe('header band', () => {
    it('renders the title and round eyebrow when a header is supplied', () => {
      render(
        <BrandThemeProvider theme={BASE} header={openHeader()}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByText('Customer Experience Survey')).toBeInTheDocument();
      expect(screen.getByText('Round 3 · Spring Cohort')).toBeInTheDocument();
    });

    it('renders the live schedule status + the formatted date window for an open round', () => {
      // Fixed window with a far-future close → stable "Open" (no countdown) AND a deterministic,
      // assertable date range, so this guards that the band wires schedule.dateRange into the DOM —
      // not just the status label.
      render(
        <BrandThemeProvider
          theme={BASE}
          header={openHeader({
            opensAt: new Date('2026-04-01T00:00:00Z'),
            closesAt: new Date('2099-12-31T00:00:00Z'),
          })}
        >
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByText(/^Open/)).toBeInTheDocument();
      expect(screen.getByText('1 Apr 2026 – 31 Dec 2099')).toBeInTheDocument();
    });

    it('omits the schedule cluster for an open-ended session (round = null)', () => {
      render(
        <BrandThemeProvider theme={BASE} header={{ title: 'Standalone Survey', round: null }}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByText('Standalone Survey')).toBeInTheDocument();
      expect(screen.queryByText(/Open|Closed|Opens|Closing/)).not.toBeInTheDocument();
    });

    it('renders no band at all with no surface, no logo, and no header', () => {
      const { container } = render(
        <BrandThemeProvider theme={BASE}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(container.querySelector('header')).not.toBeInTheDocument();
    });

    it('paints the surface colour and contrast text on the band when a surface is set', () => {
      const { container } = render(
        <BrandThemeProvider theme={{ ...BASE, surfaceColor: '#16243f' }} header={openHeader()}>
          <span>child</span>
        </BrandThemeProvider>
      );
      const wrapper = container.firstChild as HTMLElement;
      // Dark surface → white on-surface text var is emitted for the band to read.
      expect(wrapper.style.getPropertyValue('--app-on-surface')).toBe('#ffffff');

      const band = container.querySelector('header') as HTMLElement;
      expect(band.style.backgroundColor).toBe('var(--app-surface-color)');
      expect(band.style.color).toBe('var(--app-on-surface)');
    });
  });
});
