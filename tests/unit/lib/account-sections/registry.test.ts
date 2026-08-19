/**
 * Unit Tests: account-section registry (#595)
 *
 * The account surface (`/profile`, `/settings`) had no extension point, so a
 * fork adding its own section edited a Sunrise-owned page and took a conflict
 * on every upstream sync. This is the same shape as `lib/admin-nav/registry.ts`.
 *
 * @see lib/account-sections/registry.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentType } from 'react';

// The fork seam ships empty; the tests below fill it explicitly.
vi.mock('@/lib/app/account-sections', () => ({ initAppAccountSections: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { initAppAccountSections } from '@/lib/app/account-sections';
import { logger } from '@/lib/logging';
import {
  ACCOUNT_SURFACES,
  registerAccountSection,
  getRegisteredAccountSections,
  __resetAccountSectionRegistryForTests,
  type AccountSectionProps,
} from '@/lib/account-sections/registry';

/** A distinguishable stand-in — the registry never renders, only orders. */
function stubComponent(name: string): ComponentType<AccountSectionProps> {
  const C = () => null;
  C.displayName = name;
  return C;
}

beforeEach(() => {
  __resetAccountSectionRegistryForTests();
  vi.clearAllMocks();
});

describe('account-section registry', () => {
  it('ships empty, so vanilla Sunrise renders nothing on either surface', () => {
    for (const surface of ACCOUNT_SURFACES) {
      expect(getRegisteredAccountSections(surface)).toEqual([]);
    }
  });

  it('surfaces a section registered from the fork seam on both pages', () => {
    vi.mocked(initAppAccountSections).mockImplementation(() =>
      registerAccountSection({ id: 'github-connect', Component: stubComponent('GitHub') })
    );

    expect(getRegisteredAccountSections('profile').map((s) => s.id)).toEqual(['github-connect']);
    expect(getRegisteredAccountSections('settings').map((s) => s.id)).toEqual(['github-connect']);
  });

  it('honours an explicit surfaces narrowing', () => {
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      registerAccountSection({
        id: 'billing',
        surfaces: ['settings'],
        Component: stubComponent('Billing'),
      });
      registerAccountSection({
        id: 'badges',
        surfaces: ['profile'],
        Component: stubComponent('Badges'),
      });
    });

    expect(getRegisteredAccountSections('settings').map((s) => s.id)).toEqual(['billing']);
    expect(getRegisteredAccountSections('profile').map((s) => s.id)).toEqual(['badges']);
  });

  it('sorts by order, and keeps registration order within an equal order', () => {
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      registerAccountSection({ id: 'c', order: 20, Component: stubComponent('C') });
      registerAccountSection({ id: 'a', order: 10, Component: stubComponent('A') });
      // No order → 0, so it leads. The two zeroes keep insertion order, which
      // `Array.prototype.sort` guarantees (it is specified stable).
      registerAccountSection({ id: 'z1', Component: stubComponent('Z1') });
      registerAccountSection({ id: 'z2', Component: stubComponent('Z2') });
    });

    expect(getRegisteredAccountSections('profile').map((s) => s.id)).toEqual([
      'z1',
      'z2',
      'a',
      'c',
    ]);
  });

  it('is idempotent by id, so a repeated import replaces rather than duplicates', () => {
    const second = stubComponent('Second');
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      registerAccountSection({ id: 'github-connect', Component: stubComponent('First') });
      registerAccountSection({ id: 'github-connect', Component: second });
    });

    const sections = getRegisteredAccountSections('profile');
    expect(sections).toHaveLength(1);
    expect(sections[0].Component).toBe(second);
  });

  it('runs the fork init exactly once across reads of both surfaces', () => {
    getRegisteredAccountSections('profile');
    getRegisteredAccountSections('settings');
    getRegisteredAccountSections('profile');

    expect(initAppAccountSections).toHaveBeenCalledTimes(1);
  });

  it('degrades to no sections when the fork init throws', () => {
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      throw new Error('fork boom');
    });

    // /settings is where a user goes to delete their account or change a
    // password. A broken fork section must not 500 the page they went there for.
    expect(getRegisteredAccountSections('settings')).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppAccountSections threw'),
      expect.objectContaining({ error: 'fork boom' })
    );

    getRegisteredAccountSections('settings');
    expect(initAppAccountSections).toHaveBeenCalledTimes(1);
  });
});
