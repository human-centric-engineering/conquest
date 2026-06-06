/**
 * Unit test: pure helpers on the evaluation run-routes seam (F5.3) — `parseStructureSnapshot`
 * (degrade-on-malform) and `effectiveOp` (override wins, malformed-override fallback).
 */

import { describe, it, expect, vi } from 'vitest';

// These helpers don't touch the DB, but the module imports the prisma client + structure loader
// at load time — stub both so the unit can import cleanly.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-structure', () => ({
  buildEvaluationStructure: vi.fn(),
}));

import {
  effectiveOp,
  parseStructureSnapshot,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

describe('parseStructureSnapshot', () => {
  it('returns null for an absent snapshot (pre-F5.3 run)', () => {
    expect(parseStructureSnapshot(null, 'run-1')).toBeNull();
    expect(parseStructureSnapshot(undefined, 'run-1')).toBeNull();
  });

  it('parses a valid snapshot and re-narrows the audience', () => {
    const snap = {
      goal: 'Goal',
      audience: { role: 'engineer', bogusField: 'dropped' },
      sections: [{ title: 'S', questions: [] }],
    };
    const parsed = parseStructureSnapshot(snap, 'run-1');
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toBe('Goal');
    expect(parsed?.audience).toEqual({ role: 'engineer' }); // unknown sub-field dropped
  });

  it('degrades a malformed snapshot to null (does not throw)', () => {
    expect(parseStructureSnapshot({ sections: 'not-an-array' }, 'run-1')).toBeNull();
  });
});

describe('effectiveOp', () => {
  it('returns the proposedEdit when there is no override', () => {
    expect(effectiveOp({ proposedEdit: { op: 'delete_question' }, editedOverride: null })).toEqual({
      op: 'delete_question',
    });
  });

  it('prefers a valid editedOverride over the judge proposedEdit', () => {
    expect(
      effectiveOp({
        proposedEdit: { op: 'delete_question' },
        editedOverride: { op: 'replace_prompt', prompt: 'Edited' },
      })
    ).toEqual({ op: 'replace_prompt', prompt: 'Edited' });
  });

  it('falls back to proposedEdit when the override is malformed', () => {
    expect(
      effectiveOp({ proposedEdit: { op: 'delete_question' }, editedOverride: { op: 'nonsense' } })
    ).toEqual({ op: 'delete_question' });
  });

  it('returns null when neither is a valid op', () => {
    expect(effectiveOp({ proposedEdit: null, editedOverride: null })).toBeNull();
  });
});
