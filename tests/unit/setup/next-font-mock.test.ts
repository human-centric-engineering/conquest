/**
 * Tests: the `next/font` stubs in tests/setup.ts
 *
 * Base Sunrise loads no custom font, so nothing else in the suite exercises
 * these mocks — without this file the stub could rot silently and a fork would
 * rediscover the original failure. Font loaders run at MODULE SCOPE, so a
 * broken stub fails at import time and takes down every test that touches a
 * page or layout, with an error pointing nowhere near the cause.
 *
 * @see tests/setup.ts
 */

import { describe, it, expect } from 'vitest';
import { Fraunces, Hanken_Grotesk, Inter } from 'next/font/google';
import localFont from 'next/font/local';

describe('next/font mocks', () => {
  it('returns a font handle for any Google loader name, without enumeration', () => {
    // The Proxy answers any export name — that is the whole point, so a fork
    // picking different fonts never has to edit tests/setup.ts.
    for (const loader of [Fraunces, Hanken_Grotesk, Inter]) {
      expect(typeof loader).toBe('function');
      expect(loader({ subsets: ['latin'], variable: '--font-display' })).toEqual({
        className: 'mock-font',
        variable: '--mock-font',
        style: { fontFamily: 'mock' },
      });
    }
  });

  it('returns a font handle from next/font/local', () => {
    expect(localFont({ src: './whatever.woff2' })).toEqual({
      className: 'mock-font',
      variable: '--mock-font',
      style: { fontFamily: 'mock' },
    });
  });

  it('exposes the handle shape a root layout destructures', () => {
    // The realistic module-scope usage: `const display = Fraunces({...})`, then
    // `<html className={display.variable}>`.
    const display = Fraunces({ subsets: ['latin'], variable: '--font-display' });
    expect(display.variable).toBe('--mock-font');
    expect(display.className).toBe('mock-font');
  });
});
