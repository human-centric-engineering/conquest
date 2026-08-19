/**
 * Unit Tests: API-key scope vocabulary (#542)
 *
 * `ApiKeyScope` was a closed union, so a fork could *check* a scope of its own
 * but no user could ever *mint* one to check — least privilege was unavailable
 * downstream, and the workaround every fork reached for was a wider credential
 * than the job needed.
 *
 * `VALID_SCOPES` is built once at module load, so each case here re-imports the
 * module with a different `APP_API_KEY_SCOPES`. That is also the honest shape:
 * the seam is read at load, not per call.
 *
 * @see lib/auth/api-key-scopes.ts · lib/app/api-key-scopes.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const CORE = ['chat', 'analytics', 'knowledge', 'webhook', 'admin'];

/** Re-import the vocabulary with `APP_API_KEY_SCOPES` stubbed to `appScopes`. */
async function loadWithAppScopes(appScopes: readonly string[]) {
  vi.resetModules();
  vi.doMock('@/lib/app/api-key-scopes', () => ({ APP_API_KEY_SCOPES: appScopes }));
  return import('@/lib/auth/api-key-scopes');
}

/** Same, but returning the Zod schema that validates a create request. */
async function loadSchemaWithAppScopes(appScopes: readonly string[]) {
  vi.resetModules();
  vi.doMock('@/lib/app/api-key-scopes', () => ({ APP_API_KEY_SCOPES: appScopes }));
  return import('@/lib/validations/orchestration');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('@/lib/app/api-key-scopes');
});

describe('core scopes', () => {
  it('ships exactly the five core scopes when the seam is empty', async () => {
    const { listValidApiKeyScopes } = await loadWithAppScopes([]);
    expect(listValidApiKeyScopes()).toEqual(CORE);
  });

  it('rejects a scope no one declared', async () => {
    const { validateScopes } = await loadWithAppScopes([]);
    expect(validateScopes(['capture'])).toBe(false);
    expect(validateScopes(['chat', 'capture'])).toBe(false);
    expect(validateScopes(['chat', 'analytics'])).toBe(true);
  });
});

describe('app scopes', () => {
  it('makes a fork scope mintable without touching a core one', async () => {
    const { listValidApiKeyScopes, validateScopes } = await loadWithAppScopes(['capture']);

    expect(validateScopes(['capture'])).toBe(true);
    expect(listValidApiKeyScopes()).toEqual([...CORE, 'capture']);
  });

  it.each([
    ['Capture', 'upper case'],
    ['has space', 'a space'],
    ['9lives', 'a leading digit'],
    ['', 'empty'],
    ['a'.repeat(33), 'over the length cap'],
    ['kebab-case', 'a hyphen'],
  ])('drops the malformed app scope %j (%s) and logs it', async (scope) => {
    const { listValidApiKeyScopes, validateScopes } = await loadWithAppScopes([scope]);
    const { logger } = await import('@/lib/logging');

    // This set is the allowlist deciding what POST /user/api-keys will issue.
    // A junk value silently widening it is worse than the fork's scope not
    // working, so the entry is dropped rather than tolerated.
    expect(listValidApiKeyScopes()).toEqual(CORE);
    expect(validateScopes([scope])).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('malformed app scope'),
      expect.objectContaining({ scope })
    );
  });

  it('drops an app scope that collides with a core one, and logs it', async () => {
    // Redefining `admin` would be the interesting one: `hasScope` treats it as
    // satisfying everything, so a fork "adding" it must not change what the
    // set contains.
    const { listValidApiKeyScopes } = await loadWithAppScopes(['admin', 'chat']);
    const { logger } = await import('@/lib/logging');

    expect(listValidApiKeyScopes()).toEqual(CORE);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('collides with a core scope'),
      { scope: 'admin' }
    );
  });

  it('keeps the good entries when one in the list is bad', async () => {
    const { listValidApiKeyScopes } = await loadWithAppScopes(['capture', 'BAD ONE', 'digest']);
    expect(listValidApiKeyScopes()).toEqual([...CORE, 'capture', 'digest']);
  });
});

describe('createApiKeySchema', () => {
  // The schema is what actually decides whether a key CAN be minted, and it
  // reads the same list — that is the half #542 was missing, since a fork could
  // check a scope it could never create.

  it('accepts a fork scope the seam declared', async () => {
    const { createApiKeySchema } = await loadSchemaWithAppScopes(['capture']);

    const result = createApiKeySchema.safeParse({ name: 'Lock Screen', scopes: ['capture'] });

    expect(result.success).toBe(true);
  });

  it('rejects a scope nothing declared, and names the ones that exist', async () => {
    const { createApiKeySchema } = await loadSchemaWithAppScopes([]);

    const result = createApiKeySchema.safeParse({ name: 'Lock Screen', scopes: ['capture'] });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('chat');
  });

  it('still defaults to chat and still requires at least one scope', async () => {
    const { createApiKeySchema } = await loadSchemaWithAppScopes(['capture']);

    expect(createApiKeySchema.parse({ name: 'k' }).scopes).toEqual(['chat']);
    expect(createApiKeySchema.safeParse({ name: 'k', scopes: [] }).success).toBe(false);
  });
});

describe('hasScope', () => {
  it('matches a fork scope exactly', async () => {
    const { hasScope } = await loadWithAppScopes(['capture']);
    expect(hasScope(['capture'], 'capture')).toBe(true);
    expect(hasScope(['chat'], 'capture')).toBe(false);
  });

  it('still lets admin satisfy any scope, including a fork one', async () => {
    const { hasScope } = await loadWithAppScopes(['capture']);
    expect(hasScope(['admin'], 'capture')).toBe(true);
  });
});
