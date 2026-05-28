/**
 * Tests: App env-var extension seam (fork-readiness seam 11)
 *
 * `lib/env.ts` merges `appEnvSchema` (from `lib/app/env.ts`) into the
 * fail-fast startup parse. This file verifies the SEAM behaves like a real
 * fork would use it: an app declares its own server env vars, and they are
 * validated in the same parse — present-and-valid → exposed on `env`,
 * missing/invalid → boot aborts.
 *
 * We exercise the production code path (the merge in lib/env.ts) by swapping
 * `@/lib/app/env` for a non-empty schema via `vi.doMock` + dynamic import —
 * exactly the extension point a fork edits. No internal copy of the merge.
 *
 * @see lib/env.ts
 * @see lib/app/env.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const validServerEnv: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mydb',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};

/** Keys this suite manages so leftovers never bleed across tests. */
const MANAGED_KEYS = [
  'DATABASE_URL',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'NEXT_PUBLIC_APP_URL',
  'NODE_ENV',
  'APP_API_TOKEN',
];

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.resetModules();
  // Clear any doMock from a previous test so the "default empty schema" test
  // gets the real lib/app/env module.
  vi.doUnmock('@/lib/app/env');
  // All these tests run in server context (so the server schema is parsed).
  vi.stubGlobal('window', undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setEnv(vars: Record<string, string | undefined>): void {
  for (const key of MANAGED_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Make `@/lib/app/env` export an app schema requiring APP_API_TOKEN (≥ 10 chars). */
function mockAppSchema(): void {
  vi.doMock('@/lib/app/env', () => ({
    appEnvSchema: z.object({ APP_API_TOKEN: z.string().min(10) }),
  }));
}

describe('app env-var extension (seam 11)', () => {
  it('validates an app-declared var and exposes it on env', async () => {
    // Arrange — app requires APP_API_TOKEN; provide a valid one
    mockAppSchema();
    setEnv({ ...validServerEnv, APP_API_TOKEN: 'x'.repeat(12) });

    // Act
    const { env } = await import('@/lib/env');

    // Assert — the app var came through the merged parse onto `env`
    expect((env as Record<string, unknown>).APP_API_TOKEN).toBe('x'.repeat(12));
    // ...and core vars are still present (the merge didn't drop them)
    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/mydb');
  });

  it('fails fast (throws at import) when an app-declared var is missing', async () => {
    // Arrange — app requires APP_API_TOKEN but it is absent
    mockAppSchema();
    setEnv({ ...validServerEnv });

    // Act & Assert — startup parse rejects, with the env doc hint
    await expect(import('@/lib/env')).rejects.toThrow('.context/environment');
  });

  it('fails fast when an app-declared var is present but invalid', async () => {
    // Arrange — APP_API_TOKEN present but under the min(10) constraint
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAppSchema();
    setEnv({ ...validServerEnv, APP_API_TOKEN: 'short' });

    // Act & Assert — the app constraint is enforced, not just presence
    await expect(import('@/lib/env')).rejects.toThrow();
    // The failing app key is reported in the field-error output
    const reported = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(reported).toContain('APP_API_TOKEN');
  });

  it('still enforces core vars when an app schema is registered', async () => {
    // Arrange — provide the app var but omit a core var (DATABASE_URL)
    mockAppSchema();
    const { DATABASE_URL: _omit, ...rest } = validServerEnv;
    setEnv({ ...rest, APP_API_TOKEN: 'x'.repeat(12) });

    // Act & Assert — merging an app schema must not weaken core validation
    await expect(import('@/lib/env')).rejects.toThrow();
  });

  it('default (empty) app schema adds no constraints', async () => {
    // Arrange — no doMock, so the REAL lib/app/env (empty schema) is used.
    // An app var that is NOT declared must be ignored, not rejected.
    setEnv({ ...validServerEnv, APP_API_TOKEN: 'irrelevant' });

    // Act — the shipped empty appEnvSchema means core-only validation
    const { env } = await import('@/lib/env');

    // Assert — boot succeeds; undeclared app var is simply not on the typed env
    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/mydb');
  });

  it('rejects an app schema that redeclares a core SERVER key (right-wins merge would weaken it)', async () => {
    // Arrange — fork's appEnvSchema collides with the core DATABASE_URL by
    // declaring it optional. Without the collision guard, Zod merge is
    // right-wins → safeParse would succeed with DATABASE_URL absent and
    // surface later as a Prisma crash. With the guard, boot aborts and
    // names the offending key.
    vi.doMock('@/lib/app/env', () => ({
      appEnvSchema: z.object({ DATABASE_URL: z.string().optional() }),
    }));
    setEnv({ ...validServerEnv });

    // Act & Assert — startup throws with both "redeclares" and the key name in
    // the message so the operator knows what to rename and why.
    await expect(import('@/lib/env')).rejects.toThrow(
      /redeclares core Sunrise env key.*DATABASE_URL/s
    );
  });

  it('rejects an app schema that redeclares a core CLIENT key', async () => {
    // Arrange — collision against NEXT_PUBLIC_APP_URL (defined in
    // clientEnvSchema). The guard checks both core schemas, so this must
    // also reject.
    vi.doMock('@/lib/app/env', () => ({
      appEnvSchema: z.object({ NEXT_PUBLIC_APP_URL: z.string().optional() }),
    }));
    setEnv({ ...validServerEnv });

    // Act & Assert
    await expect(import('@/lib/env')).rejects.toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('names every colliding key in the error when an app schema collides on several', async () => {
    // Arrange — two collisions at once. The message must list both so the
    // operator fixes them in one pass instead of one-collision-at-a-time.
    vi.doMock('@/lib/app/env', () => ({
      appEnvSchema: z.object({
        DATABASE_URL: z.string().optional(),
        BETTER_AUTH_SECRET: z.string().optional(),
      }),
    }));
    setEnv({ ...validServerEnv });

    // Act
    const importPromise = import('@/lib/env');

    // Assert — both keys present in the thrown error
    let caught: unknown;
    try {
      await importPromise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('BETTER_AUTH_SECRET');
  });
});
