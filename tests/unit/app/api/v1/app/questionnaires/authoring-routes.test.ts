/**
 * Unit tests for the authoring route glue helpers (F2.1 / PR2).
 *
 * The pure pieces of `_lib/authoring-routes.ts` — the reorder permutation guard,
 * fork id retargeting, and admin-supplied provenance stamping — exercised without
 * a DB. (The JSON-null boundary moved to `app/api/v1/app/_lib/prisma-json.ts`;
 * see its own test.) The Prisma-touching helpers
 * (`loadScopedVersion`, `resolveQuestionKey`) are covered via the route
 * integration tests.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  applyReorder,
  audienceProvenanceForEdit,
  forkMeta,
  goalProvenanceForEdit,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import type { ForkResult } from '@/app/api/v1/app/questionnaires/_lib/fork';

describe('applyReorder', () => {
  it('assigns ordinals 0..n-1 in the requested order', async () => {
    const calls: Array<[string, number]> = [];
    await applyReorder(['a', 'b', 'c'], ['c', 'a', 'b'], (id, ordinal) => {
      calls.push([id, ordinal]);
      return Promise.resolve();
    });
    expect(calls).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('rejects an order that is not a permutation of the current children', async () => {
    const setOrdinal = vi.fn(() => Promise.resolve());
    // Foreign id 'z' (and missing 'c') — not a clean permutation.
    await expect(applyReorder(['a', 'b', 'c'], ['a', 'b', 'z'], setOrdinal)).rejects.toThrow();
    await expect(applyReorder(['a', 'b', 'c'], ['a', 'b'], setOrdinal)).rejects.toThrow();
    await expect(applyReorder(['a', 'b', 'c'], ['a', 'a', 'b'], setOrdinal)).rejects.toThrow();
    expect(setOrdinal).not.toHaveBeenCalled();
  });
});

describe('resolveForkedId', () => {
  const noFork: ForkResult = { versionId: 'v1', forked: false, versionNumber: 1 };
  const forked: ForkResult = {
    versionId: 'v2',
    forked: true,
    versionNumber: 2,
    sectionIdMap: new Map([['oldsec', 'newsec']]),
    questionIdMap: new Map([['oldq', 'newq']]),
  };

  it('returns the original id on the no-fork path', () => {
    expect(resolveForkedId(noFork, 'section', 'oldsec')).toBe('oldsec');
    expect(resolveForkedId(noFork, 'question', 'oldq')).toBe('oldq');
  });

  it('maps to the copy after a fork', () => {
    expect(resolveForkedId(forked, 'section', 'oldsec')).toBe('newsec');
    expect(resolveForkedId(forked, 'question', 'oldq')).toBe('newq');
  });

  it('returns null for an id not in the fork (stale/foreign)', () => {
    expect(resolveForkedId(forked, 'section', 'unknown')).toBeNull();
    expect(resolveForkedId(forked, 'question', 'unknown')).toBeNull();
  });
});

describe('audienceProvenanceForEdit', () => {
  it('marks only changed fields admin-supplied; unchanged keep prior provenance', () => {
    // role unchanged (stays inferred), description newly set (admin-supplied).
    const result = audienceProvenanceForEdit(
      { role: 'patient', description: 'New blurb' },
      { role: 'patient' },
      { role: 'inferred' }
    );
    expect(result).toEqual({ role: 'inferred', description: 'admin-supplied' });
  });

  it('marks a changed field admin-supplied even if it was inferred', () => {
    const result = audienceProvenanceForEdit(
      { role: 'clinician' },
      { role: 'patient' },
      { role: 'inferred' }
    );
    expect(result).toEqual({ role: 'admin-supplied' });
  });

  it('defaults to admin-supplied when there is no prior provenance', () => {
    expect(audienceProvenanceForEdit({ role: 'patient' }, null, null)).toEqual({
      role: 'admin-supplied',
    });
  });

  it('omits fields absent from the new audience', () => {
    expect(audienceProvenanceForEdit({}, { role: 'patient' }, { role: 'inferred' })).toEqual({});
  });
});

describe('goalProvenanceForEdit', () => {
  it('keeps prior provenance when the goal is unchanged', () => {
    expect(goalProvenanceForEdit('Same goal', 'Same goal', 'inferred')).toBe('inferred');
  });

  it('flips to admin-supplied when the goal changed', () => {
    expect(goalProvenanceForEdit('New goal', 'Old goal', 'inferred')).toBe('admin-supplied');
  });

  it('defaults to admin-supplied with no prior provenance', () => {
    expect(goalProvenanceForEdit('New goal', null, null)).toBe('admin-supplied');
  });
});

describe('forkMeta', () => {
  it('projects the fork outcome for the response meta', () => {
    expect(forkMeta({ versionId: 'v2', forked: true, versionNumber: 2 })).toEqual({
      forked: true,
      versionId: 'v2',
      versionNumber: 2,
    });
  });
});
