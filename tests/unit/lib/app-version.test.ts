/**
 * Tests: Fork's app version constant
 *
 * `APP_VERSION` is derived from `package.json.version` (the fork's app
 * version — distinct from `SUNRISE_VERSION` which is the upstream platform
 * version). Symmetric to `tests/unit/lib/sunrise-version.test.ts`.
 *
 * The single assertion here defends one property:
 *   - The constant matches a **valid SemVer 2.0.0 shape**, so anything
 *     consuming it (the health endpoint payload, analytics events, MCP
 *     server seeds via the sister `SUNRISE_VERSION`) can rely on the format
 *     without re-validating.
 *
 * There is NO Phase-1-placeholder-style fixed-value assertion here, because
 * the value is whatever the fork's `package.json.version` happens to be at
 * any moment — pinning it would couple the test to release cadence without
 * adding signal.
 *
 * @see lib/app-version.ts
 * @see VERSIONING.md
 */

import { describe, it, expect } from 'vitest';
import { APP_VERSION } from '@/lib/app-version';

/**
 * SemVer MAJOR.MINOR.PATCH shape. `VERSIONING.md` defers pre-release tags
 * past 1.0, so the simple form is sufficient — the full SemVer 2.0.0
 * regex would test arms the constant can never legally hold.
 */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

describe('APP_VERSION', () => {
  it('matches the SemVer MAJOR.MINOR.PATCH shape', () => {
    // Guards against `package.json.version` being set to something
    // unparseable like 'unreleased' or '0.0' — downstream consumers
    // (health endpoint, analytics, etc.) assume the shape.
    expect(APP_VERSION).toMatch(SEMVER_REGEX);
  });
});
