/**
 * Unit test: ReportScope factories and owner-key helpers (F14.x).
 *
 * Pure functions — no DB, no mocks. Asserts the structural output of each helper for both kinds
 * so the dataset/persist/view layers can rely on a single source of truth without re-testing it.
 */

import { describe, it, expect } from 'vitest';

import {
  roundScope,
  versionScope,
  scopeRoundId,
  scopeVersionId,
  scopeLabel,
  scopeSessionWhere,
  scopeOwnerWhere,
  scopeOwnerCreate,
} from '@/lib/app/questionnaire/cohort-report/scope';

const ROUND_ID = 'round-abc';
const VERSION_ID = 'version-xyz';
const LABEL = 'Q1 Pulse';

describe('roundScope', () => {
  it('returns a round-kind scope with the correct fields', () => {
    const scope = roundScope(ROUND_ID, VERSION_ID, LABEL);
    expect(scope.kind).toBe('round');
    expect(scope.versionId).toBe(VERSION_ID);
    // Narrow so TypeScript lets us read roundId.
    if (scope.kind === 'round') {
      expect(scope.roundId).toBe(ROUND_ID);
    }
    expect(scope.label).toBe(LABEL);
  });
});

describe('versionScope', () => {
  it('returns a version-kind scope with the correct fields', () => {
    const scope = versionScope(VERSION_ID, LABEL);
    expect(scope.kind).toBe('version');
    expect(scope.versionId).toBe(VERSION_ID);
    expect(scope.label).toBe(LABEL);
    // A version scope has no roundId property.
    expect(scope).not.toHaveProperty('roundId');
  });
});

describe('scopeRoundId', () => {
  it('returns the roundId for a round scope', () => {
    expect(scopeRoundId(roundScope(ROUND_ID, VERSION_ID, LABEL))).toBe(ROUND_ID);
  });

  it('returns null for a version scope', () => {
    expect(scopeRoundId(versionScope(VERSION_ID, LABEL))).toBeNull();
  });
});

describe('scopeVersionId', () => {
  it('returns the versionId for a round scope', () => {
    expect(scopeVersionId(roundScope(ROUND_ID, VERSION_ID, LABEL))).toBe(VERSION_ID);
  });

  it('returns the versionId for a version scope', () => {
    expect(scopeVersionId(versionScope(VERSION_ID, LABEL))).toBe(VERSION_ID);
  });
});

describe('scopeLabel', () => {
  it('returns the label for a round scope', () => {
    expect(scopeLabel(roundScope(ROUND_ID, VERSION_ID, LABEL))).toBe(LABEL);
  });

  it('returns the label for a version scope', () => {
    const label = 'Version-wide (all rounds)';
    expect(scopeLabel(versionScope(VERSION_ID, label))).toBe(label);
  });
});

describe('scopeSessionWhere', () => {
  it('includes roundId and versionId for a round scope — pins to one round', () => {
    const where = scopeSessionWhere(roundScope(ROUND_ID, VERSION_ID, LABEL));
    expect(where.versionId).toBe(VERSION_ID);
    expect(where.isPreview).toBe(false);
    // The round constraint is what distinguishes round-scope from version-scope.
    expect(where.roundId).toBe(ROUND_ID);
  });

  it('omits roundId for a version scope — spans all rounds and open-ended sessions', () => {
    const where = scopeSessionWhere(versionScope(VERSION_ID, LABEL));
    expect(where.versionId).toBe(VERSION_ID);
    expect(where.isPreview).toBe(false);
    // No roundId constraint — version-wide means every session regardless of round.
    expect(where).not.toHaveProperty('roundId');
  });
});

describe('scopeOwnerWhere', () => {
  it('keys on roundId for a round scope', () => {
    const where = scopeOwnerWhere(roundScope(ROUND_ID, VERSION_ID, LABEL));
    expect(where).toEqual({ roundId: ROUND_ID });
    expect(where).not.toHaveProperty('versionOwnerId');
  });

  it('keys on versionOwnerId for a version scope', () => {
    const where = scopeOwnerWhere(versionScope(VERSION_ID, LABEL));
    expect(where).toEqual({ versionOwnerId: VERSION_ID });
    expect(where).not.toHaveProperty('roundId');
  });
});

describe('scopeOwnerCreate', () => {
  it('writes the four-field round shape: scopeKind=round, roundId set, versionOwnerId null', () => {
    const create = scopeOwnerCreate(roundScope(ROUND_ID, VERSION_ID, LABEL));
    expect(create).toEqual({
      scopeKind: 'round',
      roundId: ROUND_ID,
      versionOwnerId: null,
      versionId: VERSION_ID,
    });
  });

  it('writes the four-field version shape: scopeKind=version, roundId null, versionOwnerId set', () => {
    const create = scopeOwnerCreate(versionScope(VERSION_ID, LABEL));
    expect(create).toEqual({
      scopeKind: 'version',
      roundId: null,
      versionOwnerId: VERSION_ID,
      versionId: VERSION_ID,
    });
  });
});
