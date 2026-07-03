/**
 * HeaderNav tests
 *
 * The shared renderer for the app header's primary navigation, split into a
 * desktop inline list (`HeaderNavLinks`) and a mobile far-right kebab dropdown
 * (`HeaderNavMenu`). Both take pre-resolved items (href / label / icon / active).
 *
 * @see components/layouts/header-nav.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Home, Tag } from 'lucide-react';
import { HeaderNavLinks, HeaderNavMenu, type HeaderNavItem } from '@/components/layouts/header-nav';

const items: HeaderNavItem[] = [
  { href: '/', label: 'Home', icon: Home, isActive: true },
  { href: '/pricing', label: 'Pricing', icon: Tag, isActive: false },
];

describe('components/layouts/header-nav', () => {
  describe('HeaderNavLinks (desktop)', () => {
    it('renders a link per item with its href', () => {
      render(<HeaderNavLinks items={items} />);
      expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
      expect(screen.getByRole('link', { name: /pricing/i })).toHaveAttribute('href', '/pricing');
    });

    it('marks only the active item with aria-current="page"', () => {
      render(<HeaderNavLinks items={items} />);
      expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: /pricing/i })).not.toHaveAttribute('aria-current');
    });

    it('renders nothing when there are no items', () => {
      const { container } = render(<HeaderNavLinks items={[]} />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('HeaderNavMenu (mobile kebab)', () => {
    it('renders a labelled trigger and reveals the items when opened', async () => {
      const user = userEvent.setup();
      render(<HeaderNavMenu items={items} />);

      const trigger = screen.getByRole('button', { name: /open navigation menu/i });
      expect(trigger).toBeInTheDocument();

      await user.click(trigger);

      const home = await screen.findByRole('menuitem', { name: /home/i });
      expect(home).toHaveAttribute('href', '/');
      expect(screen.getByRole('menuitem', { name: /pricing/i })).toHaveAttribute(
        'href',
        '/pricing'
      );
    });

    it('renders nothing when there are no items', () => {
      const { container } = render(<HeaderNavMenu items={[]} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
