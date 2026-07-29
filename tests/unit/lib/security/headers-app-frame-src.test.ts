/**
 * CSP frame-src seam (#450)
 *
 * `lib/app/csp.ts` lets a fork embed third-party iframes without editing the
 * platform's CSP table. The values are spliced into a header, so the seam is
 * validated once at module load — this file exercises that filter with a mocked
 * seam, since the real one is empty in vanilla Sunrise.
 *
 * Lives in its own file because the validated list is computed at import time;
 * each case needs a fresh module graph.
 *
 * @see lib/security/headers.ts · lib/app/csp.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAppFrameSrc: string[] = [];

vi.mock('@/lib/app/csp', () => ({
  get appFrameSrc() {
    return mockAppFrameSrc;
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logging', () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Re-import headers.ts with the seam set to `origins`. */
async function loadHeadersWith(origins: string[]) {
  mockAppFrameSrc.length = 0;
  mockAppFrameSrc.push(...origins);
  vi.resetModules();
  return import('@/lib/security/headers');
}

describe('CSP frame-src app seam', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves frame-src at "self" when the seam is empty (vanilla Sunrise)', async () => {
    const { getCSPConfig } = await loadHeadersWith([]);

    expect(getCSPConfig()['frame-src']).toEqual(["'self'"]);
  });

  it('adds the fork origins alongside self, in the built header', async () => {
    const { getCSP, getCSPConfig } = await loadHeadersWith([
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
    ]);

    expect(getCSPConfig()['frame-src']).toEqual([
      "'self'",
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
    ]);
    expect(getCSP()).toContain(
      "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com"
    );
  });

  it('applies in production as well as development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getCSPConfig } = await loadHeadersWith(['https://player.vimeo.com']);

    expect(getCSPConfig()['frame-src']).toContain('https://player.vimeo.com');
  });

  it('accepts a left-most wildcard and a port', async () => {
    const { getCSPConfig } = await loadHeadersWith([
      'https://*.example.com',
      'https://media.example.com:8443',
    ]);

    expect(getCSPConfig()['frame-src']).toEqual([
      "'self'",
      'https://*.example.com',
      'https://media.example.com:8443',
    ]);
  });

  it.each([
    ['*', 'a bare wildcard'],
    ['https://*', 'a scheme-wide wildcard'],
    ['http://evil.example.com', 'a plaintext origin'],
    ['data:', 'a data scheme'],
    ["'unsafe-inline'", 'a CSP keyword'],
    ['https://ok.example.com; script-src *', 'a directive-injection attempt'],
    ['https://ok.example.com https://evil.example.com', 'two origins in one entry'],
    ['https://ok.example.com/embed', 'a path'],
  ])('drops %s (%s) and warns', async (origin) => {
    const { getCSPConfig } = await loadHeadersWith([origin]);

    expect(getCSPConfig()['frame-src']).toEqual(["'self'"]);
    expect(warn).toHaveBeenCalledWith(
      'Ignoring invalid frame-src origin from lib/app/csp.ts',
      expect.objectContaining({ origin })
    );
  });

  it('keeps the valid origins when one entry in the list is invalid', async () => {
    const { getCSPConfig } = await loadHeadersWith(['https://player.vimeo.com', '*']);

    expect(getCSPConfig()['frame-src']).toEqual(["'self'", 'https://player.vimeo.com']);
  });

  it('does not touch any other directive', async () => {
    const { getCSPConfig } = await loadHeadersWith(['https://player.vimeo.com']);
    const config = getCSPConfig();

    expect(config['frame-ancestors']).toEqual(["'none'"]);
    expect(config['script-src']).not.toContain('https://player.vimeo.com');
    expect(config['connect-src']).not.toContain('https://player.vimeo.com');
  });
});
