/**
 * Demo-client detail navigation helpers — pure-function tests.
 *
 * demoClientBase and demoClientTabHref are deterministic; no mocks required.
 * The sibling of workspace-nav.test.ts.
 */

import { describe, it, expect } from 'vitest';

import {
  DEMO_CLIENT_TABS,
  demoClientBase,
  demoClientTabHref,
} from '@/lib/app/questionnaire/demo-clients/nav';

describe('demoClientBase', () => {
  it('returns the expected detail path', () => {
    expect(demoClientBase('client-1')).toBe('/admin/demo-clients/client-1');
  });

  it('interpolates arbitrary id values correctly', () => {
    expect(demoClientBase('abc')).toBe('/admin/demo-clients/abc');
  });
});

describe('demoClientTabHref', () => {
  it('returns the base for the overview tab (empty segment)', () => {
    const overview = DEMO_CLIENT_TABS.find((t) => t.id === 'overview');
    expect(overview, 'overview tab missing from DEMO_CLIENT_TABS').toBeDefined();
    // overview.segment is '' so href === base
    expect(demoClientTabHref('client-1', overview!)).toBe('/admin/demo-clients/client-1');
  });

  it('appends the segment for the branding tab', () => {
    const branding = DEMO_CLIENT_TABS.find((t) => t.id === 'branding');
    expect(branding, 'branding tab missing from DEMO_CLIENT_TABS').toBeDefined();
    expect(demoClientTabHref('client-1', branding!)).toBe('/admin/demo-clients/client-1/branding');
  });

  it('appends the segment for the knowledge tab', () => {
    const knowledge = DEMO_CLIENT_TABS.find((t) => t.id === 'knowledge');
    expect(knowledge, 'knowledge tab missing from DEMO_CLIENT_TABS').toBeDefined();
    expect(demoClientTabHref('client-1', knowledge!)).toBe(
      '/admin/demo-clients/client-1/knowledge'
    );
  });

  it('appends the segment for the management tab', () => {
    const management = DEMO_CLIENT_TABS.find((t) => t.id === 'management');
    expect(management, 'management tab missing from DEMO_CLIENT_TABS').toBeDefined();
    expect(demoClientTabHref('client-1', management!)).toBe(
      '/admin/demo-clients/client-1/management'
    );
  });
});

describe('DEMO_CLIENT_TABS', () => {
  it('leads with the exact-match overview landing tab', () => {
    expect(DEMO_CLIENT_TABS[0]?.id).toBe('overview');
    expect(DEMO_CLIENT_TABS[0]?.segment).toBe('');
    expect(DEMO_CLIENT_TABS[0]?.exact).toBe(true);
  });

  it('exposes branding, knowledge, and management as the remaining tabs', () => {
    const ids = DEMO_CLIENT_TABS.map((t) => t.id);
    expect(ids).toEqual(['overview', 'branding', 'knowledge', 'management']);
  });

  it('marks only the overview tab as exact-match', () => {
    const exact = DEMO_CLIENT_TABS.filter((t) => t.exact).map((t) => t.id);
    expect(exact).toEqual(['overview']);
  });
});
