/**
 * ProtectedNav tests
 *
 * Authenticated-route navigation. Renders Dashboard / Profile / Settings for all
 * users and the Admin link only for `role === 'ADMIN'`. Split into desktop inline
 * links (`ProtectedNav`) and a mobile kebab (`ProtectedNavMenu`) sharing the same
 * resolved items. `usePathname` is globally mocked to '/' (tests/setup.ts).
 *
 * @see components/layouts/protected-nav.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUseSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({
  useSession: () => mockUseSession(),
}));

import { ProtectedNav, ProtectedNavMenu } from '@/components/layouts/protected-nav';

afterEach(() => {
  vi.clearAllMocks();
});

describe('components/layouts/protected-nav', () => {
  describe('ProtectedNav (desktop)', () => {
    it('renders the core links and hides Admin for a non-admin user', () => {
      mockUseSession.mockReturnValue({ data: { user: { role: 'USER' } } });
      render(<ProtectedNav />);

      expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute(
        'href',
        '/dashboard'
      );
      expect(screen.getByRole('link', { name: /profile/i })).toHaveAttribute('href', '/profile');
      expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings');
      expect(screen.queryByRole('link', { name: /admin/i })).toBeNull();
    });

    it('shows the Admin link for an admin user', () => {
      mockUseSession.mockReturnValue({ data: { user: { role: 'ADMIN' } } });
      render(<ProtectedNav />);

      expect(screen.getByRole('link', { name: /admin/i })).toHaveAttribute('href', '/admin');
    });

    it('treats a missing session as non-admin', () => {
      mockUseSession.mockReturnValue({ data: null });
      render(<ProtectedNav />);

      expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /admin/i })).toBeNull();
    });
  });

  describe('ProtectedNavMenu (mobile kebab)', () => {
    it('reveals the items when opened, including Admin for an admin', async () => {
      mockUseSession.mockReturnValue({ data: { user: { role: 'ADMIN' } } });
      const user = userEvent.setup();
      render(<ProtectedNavMenu />);

      await user.click(screen.getByRole('button', { name: /open navigation menu/i }));

      expect(await screen.findByRole('menuitem', { name: /dashboard/i })).toHaveAttribute(
        'href',
        '/dashboard'
      );
      expect(screen.getByRole('menuitem', { name: /admin/i })).toHaveAttribute('href', '/admin');
    });
  });
});
