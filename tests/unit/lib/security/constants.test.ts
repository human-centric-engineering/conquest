/**
 * Unit Tests: Security Constants — envInt env-var overrides
 *
 * The internal `envInt(name, fallback)` helper (unexported) has three code paths:
 *   1. `!raw` (env var unset)                   → return fallback  [covered by most tests]
 *   2. `raw` present, parses to NaN or ≤ 0       → return fallback  [paths 2–3 were uncovered]
 *   3. `raw` present, parses to a positive int   → return parsed value
 *
 * `envInt` is observable only through `SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.*`
 * because the function itself is not exported. The module evaluates at first
 * import, so each test uses `vi.resetModules()` + a dynamic `import()` to get
 * a fresh module instance with whatever env state the test arranges.
 *
 * Tests use `RATE_LIMIT_API` as the probe for paths 2 & 3 (avoiding ADMIN /
 * ORCH_ADMIN / MCP unless independence is the thing being verified). Default
 * values:
 *   RATE_LIMIT_API        → 100
 *   RATE_LIMIT_ADMIN      → 30
 *   RATE_LIMIT_ORCH_ADMIN → 120
 *   RATE_LIMIT_MCP        → 300
 *
 * @see lib/security/constants.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('SECURITY_CONSTANTS.RATE_LIMIT.LIMITS — envInt env-var overrides', () => {
  // ── Save originals so we can restore after each test ─────────────────────
  let savedApi: string | undefined;
  let savedAdmin: string | undefined;
  let savedOrchAdmin: string | undefined;
  let savedMcp: string | undefined;

  beforeEach(() => {
    savedApi = process.env.RATE_LIMIT_API;
    savedAdmin = process.env.RATE_LIMIT_ADMIN;
    savedOrchAdmin = process.env.RATE_LIMIT_ORCH_ADMIN;
    savedMcp = process.env.RATE_LIMIT_MCP;
  });

  afterEach(() => {
    // Restore each env var to its pre-test value (or delete if previously absent)
    if (savedApi === undefined) {
      delete process.env.RATE_LIMIT_API;
    } else {
      process.env.RATE_LIMIT_API = savedApi;
    }
    if (savedAdmin === undefined) {
      delete process.env.RATE_LIMIT_ADMIN;
    } else {
      process.env.RATE_LIMIT_ADMIN = savedAdmin;
    }
    if (savedOrchAdmin === undefined) {
      delete process.env.RATE_LIMIT_ORCH_ADMIN;
    } else {
      process.env.RATE_LIMIT_ORCH_ADMIN = savedOrchAdmin;
    }
    if (savedMcp === undefined) {
      delete process.env.RATE_LIMIT_MCP;
    } else {
      process.env.RATE_LIMIT_MCP = savedMcp;
    }

    // Always reset modules after each test so the next test's import is fresh.
    vi.resetModules();
  });

  // ── Path 1: env var unset → fallback ─────────────────────────────────────

  it('uses the hardcoded default when the env var is unset', async () => {
    // Arrange: explicitly unset so there's no residual value from test setup
    delete process.env.RATE_LIMIT_API;
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: the default for API is 100, proving `!raw → return fallback`
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 3: env var set to a valid positive integer → parsed value ────────

  it('uses the env-var value when set to a positive integer', async () => {
    // Arrange
    process.env.RATE_LIMIT_API = '500';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: parsed value 500 was used — NOT the fallback 100.
    // This is the transformation the envInt() function performs; asserting
    // the exact integer proves the parseInt path ran, not just that the
    // module loaded without error.
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(500);
  });

  // ── Path 2a: env var present but non-numeric → fallback ──────────────────

  it('falls back to the default when the env var is non-numeric', async () => {
    // Arrange: parseInt('not-a-number') → NaN; Number.isFinite(NaN) is false
    process.env.RATE_LIMIT_API = 'not-a-number';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: NaN branch returns the fallback, not 0 or NaN
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 2b: env var present but zero → fallback ──────────────────────────

  it('falls back to the default when the env var is zero', async () => {
    // Arrange: parseInt('0') → 0; 0 > 0 is false → fallback
    process.env.RATE_LIMIT_API = '0';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: zero is explicitly rejected by the `n > 0` guard
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 2c: env var present but negative → fallback ─────────────────────

  it('falls back to the default when the env var is negative', async () => {
    // Arrange: parseInt('-5') → -5; -5 > 0 is false → fallback
    process.env.RATE_LIMIT_API = '-5';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: negative values are rejected
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── MCP default ──────────────────────────────────────────────────────────

  it('uses the documented 300/min default for MCP when the env var is unset', async () => {
    // Arrange: MCP defaults to 300 — a deliberate uplift over the api tier
    // (100) because MCP is server-to-server agent traffic, not human-paced.
    // This test pins the documented default so a stray edit to the constant
    // is caught immediately.
    delete process.env.RATE_LIMIT_MCP;
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(300);
  });

  it('applies the env override to MCP when set to a positive integer', async () => {
    // Arrange
    process.env.RATE_LIMIT_MCP = '1500';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: env var routes through the shared envInt() helper, so a positive
    // integer is parsed exactly the same as for ADMIN / API / ORCH_ADMIN.
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(1500);
  });

  // ── ADMIN, ORCH_ADMIN, and MCP are overridden independently ──────────────

  it('applies the override independently to API, ADMIN, ORCH_ADMIN, and MCP limits', async () => {
    // Arrange: set distinct values for each of the four overrideable limits.
    // This guards against a future refactor accidentally sharing state across
    // the envInt() invocations.
    process.env.RATE_LIMIT_API = '200';
    process.env.RATE_LIMIT_ADMIN = '60';
    process.env.RATE_LIMIT_ORCH_ADMIN = '240';
    process.env.RATE_LIMIT_MCP = '600';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: each env var is parsed independently — not sharing state
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(200);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.ADMIN).toBe(60);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.ORCH_ADMIN).toBe(240);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(600);
  });

  // ── Constants not controlled by env vars remain unchanged ─────────────────

  it('leaves non-configurable constants (AUTH, PASSWORD_RESET, CONTACT) at their hardcoded values', async () => {
    // Arrange: set all four overrideable vars to prove they don't bleed into
    // the hardcoded constants
    process.env.RATE_LIMIT_API = '999';
    process.env.RATE_LIMIT_ADMIN = '999';
    process.env.RATE_LIMIT_ORCH_ADMIN = '999';
    process.env.RATE_LIMIT_MCP = '999';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: hardcoded constants are unaffected
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.AUTH).toBe(5);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.PASSWORD_RESET).toBe(3);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.CONTACT).toBe(5);
  });
});
