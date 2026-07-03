/**
 * AppHeader tests
 *
 * The shared header shell: brand slot on the left (logo → `BrandMark`, or a
 * `logoText` override), the desktop `navigation` slot beside it, and the right
 * cluster of `HeaderActions` + the far-right `mobileMenu` slot. BrandMark and
 * HeaderActions are stubbed so the test isolates AppHeader's composition from
 * their env/session/theme dependencies.
 *
 * @see components/layouts/app-header.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/brand/brand-mark', () => ({
  BrandMark: () => <span>BrandMarkStub</span>,
}));
vi.mock('@/components/layouts/header-actions', () => ({
  HeaderActions: () => <div>HeaderActionsStub</div>,
}));

import { AppHeader } from '@/components/layouts/app-header';

describe('components/layouts/app-header', () => {
  it('renders the brand mark by default and links the logo to logoHref', () => {
    render(<AppHeader logoHref="/dashboard" />);

    const brand = screen.getByText('BrandMarkStub');
    expect(brand).toBeInTheDocument();
    expect(brand.closest('a')).toHaveAttribute('href', '/dashboard');
    expect(screen.getByText('HeaderActionsStub')).toBeInTheDocument();
  });

  it('prefers logoText over the brand mark when provided', () => {
    render(<AppHeader logoText="Acme" />);

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('BrandMarkStub')).toBeNull();
  });

  it('defaults logoHref to "/"', () => {
    render(<AppHeader logoText="Acme" />);
    expect(screen.getByText('Acme').closest('a')).toHaveAttribute('href', '/');
  });

  it('renders the desktop navigation and mobile menu slots', () => {
    render(
      <AppHeader
        navigation={<nav aria-label="desktop">DesktopNav</nav>}
        mobileMenu={<button type="button">KebabMenu</button>}
      />
    );

    expect(screen.getByText('DesktopNav')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KebabMenu' })).toBeInTheDocument();
  });
});
