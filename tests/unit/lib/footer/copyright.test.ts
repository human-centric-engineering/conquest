/**
 * Unit Tests: footer attribution resolver (#561)
 *
 * The three branches are exercised through both footers already, but this pins
 * the contract directly — in particular that a fork-supplied string is used
 * **verbatim**, with no year interpolated into it. That is the easiest part to
 * "helpfully" change later, and it would silently rewrite every fork's line.
 *
 * @see lib/footer/copyright.ts · lib/app/footer.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/footer');
});

async function resolve(year: number, legalName: string) {
  const { resolveFooterCopyright } = await import('@/lib/footer/copyright');
  return resolveFooterCopyright(year, legalName);
}

describe('resolveFooterCopyright', () => {
  it('builds the platform default when the seam is null', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: null }));

    expect(await resolve(2026, 'All Too Human Ltd')).toBe('© 2026 All Too Human Ltd');
  });

  it('does not append "All rights reserved" to the default', async () => {
    // Dropped in #561 — legally inert under Berne, and `legalName` falls back
    // to the product name, so the old default had personal forks asserting all
    // rights on behalf of a product rather than a company.
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: null }));

    expect(await resolve(2026, 'Acme')).not.toMatch(/rights reserved/i);
  });

  it('returns a fork string verbatim, interpolating nothing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: 'Made in Sheffield' }));

    const line = await resolve(2026, 'All Too Human Ltd');
    expect(line).toBe('Made in Sheffield');
    expect(line).not.toContain('2026');
    expect(line).not.toContain('All Too Human Ltd');
  });

  it('returns null when the seam is false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: false }));

    expect(await resolve(2026, 'Acme')).toBeNull();
  });

  it('passes an empty string through rather than falling back to the default', async () => {
    // `''` is falsy but is not `false`, so `footerCopyright || default` would
    // silently resurrect the platform line for a fork that set an empty string.
    // The resolver therefore distinguishes them.
    //
    // Note what BOTH footers then do: they render `{copyright && <p>…}`, so an
    // empty string collapses to the same output as `false`. That is fine — the
    // seam documents `false` as the way to omit the line — but it means this
    // assertion pins the resolver's contract, not an observable difference on
    // the page. Do not "fix" the footers to render on `!== null`; an empty
    // `<p>` is not a feature.
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: '' }));

    expect(await resolve(2026, 'Acme')).toBe('');
    expect(await resolve(2026, 'Acme')).not.toContain('©');
  });

  it('uses the year it is given rather than reading the clock', async () => {
    // Callers pass render-time year so a page cached over New Year cannot claim
    // a copyright that has expired.
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: null }));

    expect(await resolve(1999, 'Acme')).toBe('© 1999 Acme');
  });
});
