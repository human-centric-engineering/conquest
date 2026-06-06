/**
 * BrandThemeProvider — projects a resolved theme onto CSS custom properties + logo.
 *
 * @see components/app/questionnaire/chat/brand-theme-provider.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';

const BASE: ResolvedTheme = {
  ctaColor: '#112233',
  accentColor: '#445566',
  logoUrl: null,
  welcomeCopy: 'hello',
};

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
});
