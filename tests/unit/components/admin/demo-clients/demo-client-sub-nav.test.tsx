/**
 * DemoClientSubNav Component Tests
 *
 * Horizontal tab bar for the demo-client detail surface. A 'use client' component
 * that consumes `usePathname()` to decide which tab is active and builds hrefs via
 * the real `demoClientTabHref` helper (not mocked — it's pure logic).
 *
 * Test Coverage:
 * - Renders a link for every tab in DEMO_CLIENT_TABS
 * - Each tab gets its correct label and href for the given clientId
 * - Marks the matching tab as active (aria-current="page") when pathname matches
 * - Only one tab carries aria-current at a time
 * - Exact-match Overview tab lights up only on its exact href, not sub-routes
 * - Prefix-match tabs light up on deeper sub-paths
 * - The nav landmark carries its accessible label
 *
 * @see components/admin/demo-clients/demo-client-sub-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── next/navigation mock ─────────────────────────────────────────────────────

const { mockUsePathname } = vi.hoisted(() => ({
  mockUsePathname: vi.fn<() => string>(),
}));

vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { DemoClientSubNav } from '@/components/admin/demo-clients/demo-client-sub-nav';
import {
  DEMO_CLIENT_TABS,
  demoClientBase,
  demoClientTabHref,
} from '@/lib/app/questionnaire/demo-clients/nav';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CID = 'client-abc';

function renderNav(pathname: string) {
  mockUsePathname.mockReturnValue(pathname);
  return render(<DemoClientSubNav clientId={CID} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DemoClientSubNav', () => {
  describe('link rendering', () => {
    it('renders one link per tab in DEMO_CLIENT_TABS', () => {
      renderNav(demoClientBase(CID));
      expect(screen.getAllByRole('link')).toHaveLength(DEMO_CLIENT_TABS.length);
    });

    it('renders each tab with its label and the href built by the real helper', () => {
      renderNav(demoClientBase(CID));
      for (const tab of DEMO_CLIENT_TABS) {
        const link = screen.getByRole('link', { name: tab.label });
        expect(link).toHaveAttribute('href', demoClientTabHref(CID, tab));
      }
    });
  });

  describe('active tab (aria-current)', () => {
    it('marks the matching tab active when pathname equals its href', () => {
      const branding = DEMO_CLIENT_TABS.find((t) => t.id === 'branding')!;
      renderNav(demoClientTabHref(CID, branding));
      expect(screen.getByRole('link', { name: 'Branding' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    it('sets aria-current on exactly one tab when active', () => {
      const knowledge = DEMO_CLIENT_TABS.find((t) => t.id === 'knowledge')!;
      const knowledgeHref = demoClientTabHref(CID, knowledge);
      renderNav(knowledgeHref);
      const active = screen
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page');
      expect(active).toHaveLength(1);
      expect(active[0]).toHaveAttribute('href', knowledgeHref);
    });

    it('marks Overview active when pathname is exactly the client base', () => {
      renderNav(demoClientBase(CID));
      expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    it('does NOT mark Overview active on a sub-route (exact match only)', () => {
      renderNav(`${demoClientBase(CID)}/branding`);
      expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    });

    it('marks a prefix-match tab active on a deeper sub-path', () => {
      const management = DEMO_CLIENT_TABS.find((t) => t.id === 'management')!;
      renderNav(`${demoClientTabHref(CID, management)}/confirm`);
      expect(screen.getByRole('link', { name: 'Management' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    it('marks no tab active when the pathname matches nothing', () => {
      renderNav('/admin/demo-clients');
      for (const link of screen.getAllByRole('link')) {
        expect(link).not.toHaveAttribute('aria-current');
      }
    });
  });

  describe('nav landmark', () => {
    it('renders a nav element with an accessible label', () => {
      renderNav(demoClientBase(CID));
      expect(screen.getByRole('navigation', { name: /demo client sections/i })).toBeInTheDocument();
    });
  });
});
