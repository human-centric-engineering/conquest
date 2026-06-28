/**
 * release-stage seam Tests
 *
 * The seam resolves `NEXT_PUBLIC_RELEASE_STAGE` once at module load into a
 * normalised `RELEASE_STAGE` + `IS_PRERELEASE` pair. Because it reads the env
 * at import time, each case sets the env var, resets the module registry, and
 * re-imports to observe the resolved value. The key guarantee is fail-safe:
 * anything other than alpha/beta (incl. typos, empty, unset) ⇒ `stable`.
 *
 * @see lib/app/release-stage.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const ENV_KEY = 'NEXT_PUBLIC_RELEASE_STAGE';
const original = process.env[ENV_KEY];

async function loadSeam(value: string | undefined) {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  vi.resetModules();
  return import('@/lib/app/release-stage');
}

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  vi.resetModules();
});

describe('release-stage seam', () => {
  it('resolves "alpha" to a pre-release stage', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam('alpha');
    expect(RELEASE_STAGE).toBe('alpha');
    expect(IS_PRERELEASE).toBe(true);
  });

  it('resolves "beta" to a pre-release stage', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam('beta');
    expect(RELEASE_STAGE).toBe('beta');
    expect(IS_PRERELEASE).toBe(true);
  });

  it('normalises case and surrounding whitespace', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam('  ALPHA  ');
    expect(RELEASE_STAGE).toBe('alpha');
    expect(IS_PRERELEASE).toBe(true);
  });

  it('defaults to "stable" (not pre-release) when unset', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam(undefined);
    expect(RELEASE_STAGE).toBe('stable');
    expect(IS_PRERELEASE).toBe(false);
  });

  it('falls back to "stable" for an unrecognised value (fail-safe)', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam('production');
    expect(RELEASE_STAGE).toBe('stable');
    expect(IS_PRERELEASE).toBe(false);
  });

  it('treats an empty string as stable', async () => {
    const { RELEASE_STAGE, IS_PRERELEASE } = await loadSeam('');
    expect(RELEASE_STAGE).toBe('stable');
    expect(IS_PRERELEASE).toBe(false);
  });
});
