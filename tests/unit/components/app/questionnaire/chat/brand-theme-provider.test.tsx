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

/** A client that supplied its own colours — the white-label path. */
const BASE: ResolvedTheme = {
  ctaColor: '#112233',
  accentColor: '#445566',
  logoUrl: null,
  bannerUrl: null,
  welcomeCopy: 'hello',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
  hasBrandIdentity: true,
};

/** A client with no visual identity at all — the ConQuest fallback path. */
const UNBRANDED: ResolvedTheme = { ...BASE, hasBrandIdentity: false };

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

    it('renders no band for a BRANDED client with no surface, no logo, and no header', () => {
      // A client that set only colours has nothing to put in a band, so there isn't one.
      // Contrast with the unbranded case below, which always gets the ConQuest wordmark.
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

  describe('custom banner (full-bleed band replacement)', () => {
    const BANNERED: ResolvedTheme = { ...BASE, bannerUrl: 'https://acme.example/banner.jpg' };

    it('emits --app-banner-url as an escaped url()', () => {
      const { container } = render(
        <BrandThemeProvider theme={BANNERED}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect((container.firstChild as HTMLElement).style.getPropertyValue('--app-banner-url')).toBe(
        'url("https://acme.example/banner.jpg")'
      );
    });

    it('replaces the band entirely — no header element, no logo, no wordmark', () => {
      // The banner is the client's own composition; we do not draw our chrome over it.
      const { container } = render(
        <BrandThemeProvider
          theme={{ ...BANNERED, logoUrl: 'https://acme.example/logo.png' }}
          header={openHeader()}
        >
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(container.querySelector('header')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Brand logo')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('ConQuest')).not.toBeInTheDocument();
    });

    it('renders the banner in a 4:1 box matching the upload spec', () => {
      const { container } = render(
        <BrandThemeProvider theme={BANNERED}>
          <span>child</span>
        </BrandThemeProvider>
      );
      const banner = screen.getByRole('img', { name: 'Questionnaire banner' });
      expect(banner).toBeInTheDocument();
      expect(banner.className).toContain('aspect-[4/1]');
      expect(container.querySelector('[style*="--app-banner-url"]')).toBeTruthy();
    });

    it('moves the title below the banner rather than overlaying it', () => {
      // Legibility over an arbitrary uploaded image cannot be guaranteed, so the title
      // gets its own strip instead of a scrim.
      render(
        <BrandThemeProvider theme={BANNERED} header={openHeader()}>
          <span>child</span>
        </BrandThemeProvider>
      );
      const banner = screen.getByRole('img', { name: /banner/ });
      const title = screen.getByText('Customer Experience Survey');
      expect(banner).toBeInTheDocument();
      expect(title).toBeInTheDocument();
      expect(banner.contains(title)).toBe(false);
    });

    it('keeps the round and schedule metadata visible under the banner', () => {
      render(
        <BrandThemeProvider theme={BANNERED} header={openHeader()}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByText('Round 3 · Spring Cohort')).toBeInTheDocument();
      expect(screen.getByText(/^Open/)).toBeInTheDocument();
    });

    it('names the banner after the questionnaire when a title is present', () => {
      render(
        <BrandThemeProvider theme={BANNERED} header={{ title: 'Staff Survey', round: null }}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByRole('img', { name: 'Staff Survey banner' })).toBeInTheDocument();
    });

    it('counts as brand identity, so a banner alone suppresses the ConQuest fallback', () => {
      const { container } = render(
        <BrandThemeProvider theme={{ ...BANNERED, hasBrandIdentity: true }}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect((container.firstChild as HTMLElement).dataset.brand).toBeUndefined();
    });
  });

  describe('ConQuest default brand (no client identity)', () => {
    it('renders a band with the ConQuest wordmark even with no logo and no header', () => {
      // The whole point of the fallback: an unbranded questionnaire must never render
      // as an anonymous grey surface, and must not depend on a title being present.
      const { container } = render(
        <BrandThemeProvider theme={UNBRANDED}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(container.querySelector('header')).toBeInTheDocument();
      expect(screen.getByLabelText('ConQuest')).toBeInTheDocument();
      expect(screen.getByText('Con')).toBeInTheDocument();
      expect(screen.getByText('Quest')).toBeInTheDocument();
    });

    it('marks the wrapper data-brand="conquest" so the mode-aware CSS palette applies', () => {
      const { container } = render(
        <BrandThemeProvider theme={UNBRANDED}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect((container.firstChild as HTMLElement).dataset.brand).toBe('conquest');
    });

    it('paints the band with the mode-aware band tokens, not a fixed hex', () => {
      const { container } = render(
        <BrandThemeProvider theme={UNBRANDED}>
          <span>child</span>
        </BrandThemeProvider>
      );
      const band = container.querySelector('header') as HTMLElement;
      expect(band.style.backgroundColor).toBe('var(--cq-band-bg)');
      expect(band.style.color).toBe('var(--cq-band-fg)');
    });

    it('anchors the title opposite the wordmark, as it does opposite a client logo', () => {
      const { container } = render(
        <BrandThemeProvider theme={UNBRANDED} header={{ title: 'Standalone Survey', round: null }}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.getByText('Standalone Survey')).toBeInTheDocument();
      expect(container.querySelector('.items-end')).toBeInTheDocument();
    });

    it('yields to a client logo — the wordmark never competes with real branding', () => {
      const { container } = render(
        <BrandThemeProvider theme={{ ...BASE, logoUrl: 'https://acme.example/logo.png' }}>
          <span>child</span>
        </BrandThemeProvider>
      );
      expect(screen.queryByLabelText('ConQuest')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Brand logo')).toBeInTheDocument();
      expect((container.firstChild as HTMLElement).dataset.brand).toBeUndefined();
    });
  });
});
