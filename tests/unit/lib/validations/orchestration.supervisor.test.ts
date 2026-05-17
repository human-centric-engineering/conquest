/**
 * Schema-level tests for supervisorConfigSchema + reportConfigSchema.
 *
 * The executor-level tests in
 * `tests/unit/lib/orchestration/engine/executors/supervisor.test.ts`
 * exercise these via `executeSupervisor(step({...}), ctx)` — which
 * parses the config internally. These tests target the schemas
 * directly via `.parse()` / `.safeParse()` so a future refactor that
 * uses the schemas outside the executor (e.g. UI form validation,
 * import/export) still has the load-bearing rules covered.
 */

import { describe, expect, it } from 'vitest';

import { supervisorConfigSchema, reportConfigSchema } from '@/lib/validations/orchestration';

describe('supervisorConfigSchema', () => {
  const minimal = { assessmentCriteria: 'Was the workflow correct?' };

  it('accepts the minimal config', () => {
    const result = supervisorConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects an empty assessmentCriteria', () => {
    expect(supervisorConfigSchema.safeParse({ assessmentCriteria: '' }).success).toBe(false);
  });

  it('rejects a missing assessmentCriteria', () => {
    expect(supervisorConfigSchema.safeParse({}).success).toBe(false);
  });

  it("accepts failOnVerdict='never' + errorStrategy='skip' (the audit template's pattern)", () => {
    // The provider-model-audit template uses this exact pair: advisory
    // verdict (failOnVerdict='never') with skip-on-error so a flaky judge
    // model can't flip a successful audit to FAILED. Must remain valid.
    const result = supervisorConfigSchema.safeParse({
      ...minimal,
      failOnVerdict: 'never',
      errorStrategy: 'skip',
    });
    expect(result.success).toBe(true);
  });

  it("rejects the trap: failOnVerdict='fail' + errorStrategy='skip'", () => {
    const result = supervisorConfigSchema.safeParse({
      ...minimal,
      failOnVerdict: 'fail',
      errorStrategy: 'skip',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/silently absorb|errorStrategy/i);
    }
  });

  it("accepts failOnVerdict='fail' + errorStrategy='fail' (gate-the-workflow pattern)", () => {
    const result = supervisorConfigSchema.safeParse({
      ...minimal,
      failOnVerdict: 'fail',
      errorStrategy: 'fail',
    });
    expect(result.success).toBe(true);
  });

  it("accepts failOnVerdict='fail' + errorStrategy='fallback' (route-to-rollback pattern)", () => {
    const result = supervisorConfigSchema.safeParse({
      ...minimal,
      failOnVerdict: 'fail',
      errorStrategy: 'fallback',
      fallbackStepId: 'rollback',
    });
    expect(result.success).toBe(true);
  });

  it("accepts failOnVerdict='fail' + errorStrategy='retry' (retry-the-judge pattern)", () => {
    // Rarely useful — the LLM may produce the same verdict on retry —
    // but the engine will accept it and we don't want to over-restrict.
    const result = supervisorConfigSchema.safeParse({
      ...minimal,
      failOnVerdict: 'fail',
      errorStrategy: 'retry',
      retryCount: 2,
    });
    expect(result.success).toBe(true);
  });

  it('accepts minWeaknesses=0 (no floor) — discouraged but not invalid', () => {
    const result = supervisorConfigSchema.safeParse({ ...minimal, minWeaknesses: 0 });
    expect(result.success).toBe(true);
  });

  it('rejects a negative minWeaknesses', () => {
    expect(supervisorConfigSchema.safeParse({ ...minimal, minWeaknesses: -1 }).success).toBe(false);
  });

  it('rejects a non-integer minWeaknesses', () => {
    expect(supervisorConfigSchema.safeParse({ ...minimal, minWeaknesses: 1.5 }).success).toBe(
      false
    );
  });

  it('accepts includeStepOutputs values from the enum and rejects others', () => {
    for (const mode of ['auto', 'all', 'terminal-only'] as const) {
      expect(
        supervisorConfigSchema.safeParse({ ...minimal, includeStepOutputs: mode }).success
      ).toBe(true);
    }
    expect(
      supervisorConfigSchema.safeParse({ ...minimal, includeStepOutputs: 'aggressive' }).success
    ).toBe(false);
  });

  it('accepts an empty redTeamPrompts array (built-in defaults will be used)', () => {
    const result = supervisorConfigSchema.safeParse({ ...minimal, redTeamPrompts: [] });
    expect(result.success).toBe(true);
  });
});

describe('reportConfigSchema', () => {
  it('accepts the minimal config (all fields optional)', () => {
    expect(reportConfigSchema.safeParse({}).success).toBe(true);
  });

  it('accepts format: "markdown"', () => {
    expect(reportConfigSchema.safeParse({ format: 'markdown' }).success).toBe(true);
  });

  it('rejects an unknown format value', () => {
    expect(reportConfigSchema.safeParse({ format: 'pdf' }).success).toBe(false);
  });

  it('accepts the three includeStepOutputs modes', () => {
    for (const mode of ['auto', 'all', 'terminal-only'] as const) {
      expect(reportConfigSchema.safeParse({ includeStepOutputs: mode }).success).toBe(true);
    }
  });

  it('coexists with errorStrategy from the base schema', () => {
    expect(
      reportConfigSchema.safeParse({ errorStrategy: 'skip', includeStepOutputs: 'auto' }).success
    ).toBe(true);
  });
});
