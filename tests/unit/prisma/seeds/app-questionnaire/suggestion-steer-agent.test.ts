import { describe, it, expect, vi } from 'vitest';

import steerAgentSeed from '@/prisma/seeds/app-questionnaire/098-suggestion-steer-agent';
import {
  QUESTIONNAIRE_STEER_AGENT_SLUG,
  QUESTIONNAIRE_EDIT_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/098-suggestion-steer-agent` seed.
 *
 * Contract:
 *  - resolves the service-account admin and fails loudly if absent;
 *  - upserts exactly one AiAgent keyed on the steer slug — which must stay DISTINCT from the
 *    Structure Edit Agent's, the thing the F5.4 AI leg deliberately did not reuse;
 *  - ships an empty binding, so it resolves the `reasoning` tier at call time;
 *  - is private (visibility internal), an app component (isSystem false), active, budget-capped;
 *  - the `update` branch re-asserts isSystem ONLY, so a re-seed cannot clobber an operator's
 *    model, temperature or budget;
 *  - declares the path-derived SeedHistory key.
 *
 * The slug-collision assertion is not padding. The two agents take the same kind of input — a
 * plain-English instruction about a questionnaire — and have opposite mandates: the editor never
 * rewrites wording, this one only rewrites wording. Pointing them at one row would give whichever
 * loaded second a persona describing the other's job.
 */

/** @param admin what `user.findFirst` returns — `null` models a database with no service account. */
function makeCtx(admin: { id: string } | null = { id: 'admin-1' }) {
  const findFirst = vi.fn().mockResolvedValue(admin);
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-1' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;

  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/098-suggestion-steer-agent seed', () => {
  it('upserts the steer agent private, app-owned, active and budget-capped', async () => {
    const { ctx, upsert } = makeCtx();

    await steerAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_STEER_AGENT_SLUG });
    expect(arg.create.slug).toBe(QUESTIONNAIRE_STEER_AGENT_SLUG);
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('is a different agent from the Structure Edit Agent', async () => {
    // Opposite mandates on the same shape of input. One row for both would give whichever loaded
    // second a persona describing the other's job.
    const { ctx, upsert } = makeCtx();

    await steerAgentSeed.run(ctx);

    expect(QUESTIONNAIRE_STEER_AGENT_SLUG).not.toBe(QUESTIONNAIRE_EDIT_AGENT_SLUG);
    expect(upsert.mock.calls[0][0].create.systemInstructions).toMatch(/reword/i);
  });

  it('ships an empty binding, so the reasoning tier is resolved at call time', async () => {
    // Not a pin: `steer-edit.ts` asks `resolveAgentProviderAndModel` for the reasoning tier, the
    // same tier the judges it reconciles with run on. A hardcoded id here would silently outrank
    // that on every deployment.
    const { ctx, upsert } = makeCtx();

    await steerAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.model).toBe('');
    expect(upsert.mock.calls[0][0].create.provider).toBe('');
  });

  it('re-asserts only isSystem on re-seed, leaving an operator’s choices alone', async () => {
    // The runner re-runs a unit on every source-hash change, so this fires far more often than
    // "on upgrade" — an update branch that restated the model would undo a deliberate override.
    const { ctx, upsert } = makeCtx();

    await steerAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, upsert } = makeCtx(null);

    await expect(steerAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(steerAgentSeed.name).toBe('app-questionnaire/098-suggestion-steer-agent');
  });
});
