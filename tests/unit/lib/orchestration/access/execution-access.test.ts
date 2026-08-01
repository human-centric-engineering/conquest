/**
 * Tests for `lib/orchestration/access/execution-access.ts`.
 *
 * This module is the single point at which "can this admin see this
 * execution?" is decided for 15 routes and the live-engine dashboard. It has
 * to hold two lines at once:
 *
 *   - system-owned runs (`userId === null`) are visible to every admin, or
 *     scheduled and inbound runs vanish from the UI and their approval gates
 *     become unclearable (#502);
 *   - one admin's own runs stay invisible to another admin, which is the
 *     property the whole ownership check exists for.
 *
 * Both directions are asserted below, including the null-ish caller-id edge
 * that a naive `execution.userId === adminUserId` comparison gets wrong.
 */

import { describe, it, expect } from 'vitest';

import {
  adminCanViewExecution,
  executionAccessBasis,
  executionVisibilityWhere,
} from '@/lib/orchestration/access/execution-access';

const ADMIN_ID = 'admin-1';
const OTHER_ADMIN_ID = 'admin-2';

describe('executionAccessBasis', () => {
  it('reports owner for the caller’s own run', () => {
    expect(executionAccessBasis({ userId: ADMIN_ID }, ADMIN_ID)).toBe('owner');
  });

  it('reports system for an unowned run', () => {
    expect(executionAccessBasis({ userId: null }, ADMIN_ID)).toBe('system');
  });

  it('reports null for another admin’s run', () => {
    expect(executionAccessBasis({ userId: OTHER_ADMIN_ID }, ADMIN_ID)).toBeNull();
  });

  it('reports null for a missing row', () => {
    expect(executionAccessBasis(null, ADMIN_ID)).toBeNull();
    expect(executionAccessBasis(undefined, ADMIN_ID)).toBeNull();
  });

  it('reports system, not owner, when the caller id is empty', () => {
    // An empty or otherwise falsy caller id must never be read as owning
    // every unowned row: `'' === null` is false in JS, but a refactor that
    // compared loosely, or ordered the checks the other way, would grant
    // 'owner' here and silently skip the access audit that 'system' triggers.
    expect(executionAccessBasis({ userId: null }, '')).toBe('system');
  });
});

describe('adminCanViewExecution', () => {
  it('admits own and system-owned runs, refuses everything else', () => {
    expect(adminCanViewExecution({ userId: ADMIN_ID }, ADMIN_ID)).toBe(true);
    expect(adminCanViewExecution({ userId: null }, ADMIN_ID)).toBe(true);
    expect(adminCanViewExecution({ userId: OTHER_ADMIN_ID }, ADMIN_ID)).toBe(false);
    expect(adminCanViewExecution(null, ADMIN_ID)).toBe(false);
  });
});

describe('executionVisibilityWhere', () => {
  it('produces exactly two arms: the caller, and unowned rows', () => {
    // The shape is asserted literally because route tests match against it,
    // and because a third arm here would be a cross-admin read across every
    // list, count, and dashboard query at once.
    expect(executionVisibilityWhere(ADMIN_ID)).toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }],
    });
  });

  it('never emits a bare `userId: undefined` arm that would match all rows', () => {
    // Prisma drops `undefined` from a where clause, so an arm that resolved
    // to `{ userId: undefined }` would degrade to "no filter" — every admin
    // seeing every run. Pinning the arms as own-id-then-null rules it out.
    const where = executionVisibilityWhere(ADMIN_ID) as { OR: { userId: string | null }[] };
    for (const arm of where.OR) {
      expect(arm.userId === undefined).toBe(false);
    }
  });
});
