/**
 * Unit test: ReportScope factories and owner-key helpers (F14.x).
 *
 * Pure functions — no DB, no mocks. Asserts the structural output of each helper for both kinds
 * so the dataset/persist/view layers can rely on a single source of truth without re-testing it.
 *
 * Covers all three owners: round, version, and experience_step (F15.4).
 */

import { describe, it, expect } from 'vitest';

import {
  roundScope,
  versionScope,
  experienceStepScope,
  scopeRoundId,
  scopeStepId,
  scopeVersionId,
  scopeLabel,
  scopeSessionWhere,
  scopeOwnerWhere,
  scopeOwnerCreate,
} from '@/lib/app/questionnaire/cohort-report/scope';

const ROUND_ID = 'round-abc';
const VERSION_ID = 'version-xyz';
const STEP_ID = 'step-def';
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
  it('writes the round shape: scopeKind=round, roundId set, other owner keys null', () => {
    const create = scopeOwnerCreate(roundScope(ROUND_ID, VERSION_ID, LABEL));
    expect(create).toEqual({
      scopeKind: 'round',
      roundId: ROUND_ID,
      versionOwnerId: null,
      experienceStepOwnerId: null,
      versionId: VERSION_ID,
    });
  });

  it('writes the version shape: scopeKind=version, versionOwnerId set, other owner keys null', () => {
    const create = scopeOwnerCreate(versionScope(VERSION_ID, LABEL));
    expect(create).toEqual({
      scopeKind: 'version',
      roundId: null,
      versionOwnerId: VERSION_ID,
      experienceStepOwnerId: null,
      versionId: VERSION_ID,
    });
  });

  it('writes the step shape: scopeKind=experience_step, only experienceStepOwnerId set', () => {
    const create = scopeOwnerCreate(experienceStepScope(STEP_ID, VERSION_ID, LABEL));
    expect(create).toEqual({
      scopeKind: 'experience_step',
      roundId: null,
      versionOwnerId: null,
      experienceStepOwnerId: STEP_ID,
      versionId: VERSION_ID,
    });
  });

  it('sets EXACTLY ONE owner key for every scope kind', () => {
    // The three nullable-unique columns coexist only because at most one is ever non-null. A row
    // with two set would satisfy two owners at once; a row with none would collide with the next
    // such row on every unique index.
    const scopes = [
      roundScope(ROUND_ID, VERSION_ID, LABEL),
      versionScope(VERSION_ID, LABEL),
      experienceStepScope(STEP_ID, VERSION_ID, LABEL),
    ];
    for (const scope of scopes) {
      const { roundId, versionOwnerId, experienceStepOwnerId } = scopeOwnerCreate(scope);
      const set = [roundId, versionOwnerId, experienceStepOwnerId].filter((v) => v !== null);
      expect(set).toHaveLength(1);
    }
  });

  it('always sets versionId, whatever the owner', () => {
    // buildCohortDataset resolves questions, data slots, profile fields and the scoring schema by
    // this one versionId. A row without it would have no analysable subject.
    expect(scopeOwnerCreate(roundScope(ROUND_ID, VERSION_ID, LABEL)).versionId).toBe(VERSION_ID);
    expect(scopeOwnerCreate(versionScope(VERSION_ID, LABEL)).versionId).toBe(VERSION_ID);
    expect(scopeOwnerCreate(experienceStepScope(STEP_ID, VERSION_ID, LABEL)).versionId).toBe(
      VERSION_ID
    );
  });
});

describe('experience-step scope (F15.4)', () => {
  it('keys the owner on experienceStepOwnerId alone', () => {
    const where = scopeOwnerWhere(experienceStepScope(STEP_ID, VERSION_ID, LABEL));
    expect(where).toEqual({ experienceStepOwnerId: STEP_ID });
    expect(where).not.toHaveProperty('roundId');
    expect(where).not.toHaveProperty('versionOwnerId');
  });

  it('filters sessions by the denormalised experienceStepId', () => {
    // Not by joining AppExperienceRunLeg — that pointer is unmodelled (UG-1), so there is no
    // relation to join through.
    const where = scopeSessionWhere(experienceStepScope(STEP_ID, VERSION_ID, LABEL));
    expect(where).toEqual({
      versionId: VERSION_ID,
      isPreview: false,
      experienceStepId: STEP_ID,
    });
  });

  it('does NOT scope by versionId alone', () => {
    // The load-bearing assertion. Filtering on versionId alone would sweep in every ordinary round
    // and walk-up session on the same questionnaire and report them as part of the journey.
    const where = scopeSessionWhere(experienceStepScope(STEP_ID, VERSION_ID, LABEL));
    expect(where.experienceStepId).toBe(STEP_ID);
  });

  it('excludes preview sessions like every other scope', () => {
    expect(scopeSessionWhere(experienceStepScope(STEP_ID, VERSION_ID, LABEL)).isPreview).toBe(
      false
    );
  });

  it('carries a single versionId — the step pins exactly one questionnaire version', () => {
    // This is what lets buildCohortDataset and chart-series.ts keep their single-data-slot-
    // vocabulary assumption and need zero changes. An experience-WIDE scope would span versions
    // whose AppDataSlot ids differ, and fills from another version would be silently dropped.
    const scope = experienceStepScope(STEP_ID, VERSION_ID, LABEL);
    expect(scopeVersionId(scope)).toBe(VERSION_ID);
  });

  it('reports its step id and no round id', () => {
    const scope = experienceStepScope(STEP_ID, VERSION_ID, LABEL);
    expect(scopeStepId(scope)).toBe(STEP_ID);
    expect(scopeRoundId(scope)).toBeNull();
  });

  it('reports null stepId for the other two scopes', () => {
    expect(scopeStepId(roundScope(ROUND_ID, VERSION_ID, LABEL))).toBeNull();
    expect(scopeStepId(versionScope(VERSION_ID, LABEL))).toBeNull();
  });
});
