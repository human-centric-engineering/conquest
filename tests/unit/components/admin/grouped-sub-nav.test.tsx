/**
 * GroupedSubNav Component Tests
 *
 * Shared presentational sub-nav used by the questionnaire workspace and demo-client
 * surfaces. Renders a flat single row for one group, or a two-tier (groups + active
 * group's children) layout for many. A 'use client' component reading usePathname()
 * for active-state; all hrefs are supplied by the caller.
 *
 * @see components/admin/grouped-sub-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUsePathname } = vi.hoisted(() => ({
  mockUsePathname: vi.fn<() => string>(),
}));

vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
}));

import { GroupedSubNav, type SubNavGroup } from '@/components/admin/grouped-sub-nav';

const flatGroup: SubNavGroup = {
  id: 'only',
  label: 'Only',
  href: '/base',
  tabs: [
    { id: 'overview', label: 'Overview', href: '/base', exact: true },
    { id: 'branding', label: 'Branding', href: '/base/branding' },
    { id: 'management', label: 'Management', href: '/base/management' },
  ],
};

const twoTier: SubNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    href: '/base',
    tabs: [{ id: 'overview', label: 'Overview', href: '/base', exact: true }],
  },
  {
    id: 'build',
    label: 'Build',
    href: '/base/structure',
    tabs: [
      { id: 'structure', label: 'Structure', href: '/base/structure' },
      { id: 'slots', label: 'Slots', href: '/base/slots' },
    ],
  },
  {
    id: 'results',
    label: 'Results',
    href: '/base/analytics',
    dimmed: true,
    dimmedHint: 'Results appear later',
    tabs: [
      { id: 'analytics', label: 'Analytics', href: '/base/analytics' },
      { id: 'scoring', label: 'Scoring', href: '/base/scoring' },
    ],
  },
];

beforeEach(() => vi.clearAllMocks());

describe('GroupedSubNav — flat (single group)', () => {
  it('renders every tab in one tier (no nested group links)', () => {
    mockUsePathname.mockReturnValue('/base');
    render(<GroupedSubNav groups={[flatGroup]} ariaLabel="Flat sections" />);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    for (const label of ['Overview', 'Branding', 'Management']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the matching tab active and respects exact match', () => {
    mockUsePathname.mockReturnValue('/base/branding');
    render(<GroupedSubNav groups={[flatGroup]} ariaLabel="Flat sections" />);
    expect(screen.getByRole('link', { name: 'Branding' })).toHaveAttribute('aria-current', 'page');
    // Overview is exact → not active on a sub-route.
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});

describe('GroupedSubNav — two-tier (multiple groups)', () => {
  it('renders only the active group children in the second tier', () => {
    mockUsePathname.mockReturnValue('/base/structure');
    render(<GroupedSubNav groups={twoTier} ariaLabel="Two sections" />);
    // Tier-1 group links present.
    for (const label of ['Overview', 'Build', 'Results']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    // Active group (Build) children shown; Results children hidden.
    expect(screen.getByRole('link', { name: 'Structure' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Slots' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
  });

  it('omits the second tier for a single-tab active group', () => {
    mockUsePathname.mockReturnValue('/base');
    render(<GroupedSubNav groups={twoTier} ariaLabel="Two sections" />);
    // Overview active, single child → no child row, so Build's children are absent.
    expect(screen.queryByRole('link', { name: 'Structure' })).not.toBeInTheDocument();
  });

  it('applies dim styling + tooltip to a dimmed, inactive group', () => {
    mockUsePathname.mockReturnValue('/base/structure');
    render(<GroupedSubNav groups={twoTier} ariaLabel="Two sections" />);
    const results = screen.getByRole('link', { name: 'Results' });
    expect(results).toHaveClass('opacity-50');
    expect(results).toHaveAttribute('title', 'Results appear later');
  });

  it('does not dim a group once it is active', () => {
    mockUsePathname.mockReturnValue('/base/analytics');
    render(<GroupedSubNav groups={twoTier} ariaLabel="Two sections" />);
    // Results is now the active group → emphasis wins over dim.
    expect(screen.getByRole('link', { name: 'Results' })).not.toHaveClass('opacity-50');
  });
});
