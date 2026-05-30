/**
 * Tests: Sunrise platform version constant
 *
 * `SUNRISE_VERSION` is Sunrise's source-of-truth for the platform version
 * (the public-surface contract lives in `VERSIONING.md`). This test defends
 * the one property the rest of the codebase relies on: the constant matches
 * a **valid SemVer MAJOR.MINOR.PATCH shape**, so anything consuming it
 * (the health endpoint payload, the eventual Hub discovery, CHANGELOG
 * tooling) can rely on the format without re-validating.
 *
 * An earlier draft also pinned the literal value (`'0.0.0'` during Phase 1)
 * to force the Phase-2 flip to be a deliberate, diff-visible change. That
 * pin was removed when v0.0.1 shipped — keeping it would make every future
 * release bump a release-cadence tax (the test would fail until a
 * maintainer updated the literal), and the SemVer-shape regex already
 * catches the realistic failure mode (a fork setting the constant to a
 * malformed string like 'unreleased' or '0.0').
 *
 * @see lib/sunrise-version.ts
 * @see VERSIONING.md
 */

import { describe, it, expect } from 'vitest';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';

/**
 * SemVer MAJOR.MINOR.PATCH shape. `VERSIONING.md` defers pre-release tags
 * past 1.0, so the simple form is sufficient — the full SemVer 2.0.0 regex
 * would test arms `SUNRISE_VERSION` can never legally hold under the
 * current versioning policy. If pre-release support lands later, widen the
 * regex (and the policy doc) together.
 */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

describe('SUNRISE_VERSION', () => {
  it('matches the SemVer MAJOR.MINOR.PATCH shape', () => {
    // Guards a fork from setting the constant to a non-SemVer string like
    // 'unreleased' or '0.0' — downstream consumers (health endpoint, Hub
    // discovery) assume the shape.
    expect(SUNRISE_VERSION).toMatch(SEMVER_REGEX);
  });
});
