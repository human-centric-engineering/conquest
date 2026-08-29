import { describe, it, expect, vi } from 'vitest';

import brandImportAgentSeed from '@/prisma/seeds/app-questionnaire/099-brand-import-agent';
import { BRAND_IMPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/099-brand-import-agent` seed.
 *
 * Contract, the same one every app agent seed keeps:
 *  - resolves the service-account admin and fails loudly if absent;
 *  - upserts exactly one AiAgent keyed on the brand-import slug;
 *  - ships an EMPTY binding, so the tier is resolved at call time;
 *  - is private (visibility internal), an app component (isSystem false), active, budget-capped;
 *  - the `update` branch re-asserts isSystem ONLY, so a re-seed cannot clobber an operator's
 *    model, temperature or budget;
 *  - declares the path-derived SeedHistory key.
 *
 * The empty binding is the load-bearing one here, and for a reason specific to this agent. With a
 * screenshot attached the analyst needs a VISION-capable model, and vision lives on the chat models
 * in the curated matrix — so `assign-roles.ts` asks `resolveAgentProviderAndModel` for the `chat`
 * tier and degrades to assigning from the numbers when the resolved model cannot see. A hardcoded
 * id here would silently outrank that resolution on every deployment, and the degradation path
 * would then depend on a pin nobody chose.
 *
 * The low temperature is asserted too: this is a classification over a fixed list of measured
 * hexes, not a generative task, and variation would show up as the same screenshot mapping to a
 * different palette twice — which reads as the feature being unreliable rather than as a setting.
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

describe('app-questionnaire/099-brand-import-agent seed', () => {
  it('upserts the analyst private, app-owned, active and budget-capped', async () => {
    const { ctx, upsert } = makeCtx();

    await brandImportAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: BRAND_IMPORT_AGENT_SLUG });
    expect(arg.create.slug).toBe(BRAND_IMPORT_AGENT_SLUG);
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('ships an empty binding, so a vision-capable model can be resolved at call time', async () => {
    // Not a pin. With a screenshot attached the analyst needs vision, which lives on the chat
    // models — `assign-roles.ts` resolves that tier and degrades to the numbers when it cannot see.
    const { ctx, upsert } = makeCtx();

    await brandImportAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.model).toBe('');
    expect(upsert.mock.calls[0][0].create.provider).toBe('');
  });

  it('runs cold, because the same screenshot must map the same way twice', async () => {
    const { ctx, upsert } = makeCtx();

    await brandImportAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.temperature).toBeLessThanOrEqual(0.2);
  });

  it('states the measurement principle in the persona itself', async () => {
    // The filter in `narrowAssignments` is what actually enforces it, but an agent whose own
    // instructions invited invention would be fighting its own guard on every call.
    const { ctx, upsert } = makeCtx();

    await brandImportAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.systemInstructions).toMatch(/never invent/i);
  });

  it('re-asserts only isSystem on re-seed, leaving an operator’s choices alone', async () => {
    // The runner re-runs a unit on every source-hash change, so this fires far more often than
    // "on upgrade" — an update branch that restated the model would undo a deliberate override.
    const { ctx, upsert } = makeCtx();

    await brandImportAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, upsert } = makeCtx(null);

    await expect(brandImportAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(brandImportAgentSeed.name).toBe('app-questionnaire/099-brand-import-agent');
  });
});
