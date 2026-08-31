import { describe, it, expect, vi } from 'vitest';

import brandContrastAgentSeed from '@/prisma/seeds/app-questionnaire/100-brand-contrast-agent';
import { BRAND_CONTRAST_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/100-brand-contrast-agent` seed.
 *
 * The same contract every app agent seed keeps — service-account admin, one upsert, empty binding,
 * private, app-owned, budget-capped, an `update` branch that cannot clobber an operator's choices,
 * a path-derived key.
 *
 * Two are load-bearing for this agent in particular:
 *
 *  - **the low temperature.** The adviser chooses between a handful of enumerated repairs. Variation
 *    would show up as the same theme producing a different recommendation on two consecutive
 *    presses of the same button, which an admin reads as the feature being unreliable rather than
 *    as a setting.
 *  - **the persona's own constraint.** `applyPicks` is what actually enforces "you may only choose
 *    from what you were offered", but an agent whose instructions invited it to propose a colour
 *    would be fighting its own guard on every call — and the rationale it writes, which nothing can
 *    range-check, would start describing colours that are not in the proposal.
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

describe('app-questionnaire/100-brand-contrast-agent seed', () => {
  it('upserts the adviser private, app-owned, active and budget-capped', async () => {
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: BRAND_CONTRAST_AGENT_SLUG });
    expect(arg.create.slug).toBe(BRAND_CONTRAST_AGENT_SLUG);
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('ships an empty binding, so the tier is resolved at call time', async () => {
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.model).toBe('');
    expect(upsert.mock.calls[0][0].create.provider).toBe('');
  });

  it('runs cold, because the same theme must be advised on the same way twice', async () => {
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.temperature).toBeLessThanOrEqual(0.2);
  });

  it('tells the adviser it is choosing, not proposing colours of its own', async () => {
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.systemInstructions).toMatch(/choose between them/i);
  });

  it('tells it never to claim a change is invisible', async () => {
    // The rationale is the one thing the model authors freely, and "you won't even notice" is the
    // sentence that would turn an honest proposal into a sales pitch for our own suggestion.
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].create.systemInstructions).toMatch(/never pretend/i);
  });

  it('re-asserts only isSystem on re-seed, leaving an operator’s choices alone', async () => {
    const { ctx, upsert } = makeCtx();

    await brandContrastAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, upsert } = makeCtx(null);

    await expect(brandContrastAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(brandContrastAgentSeed.name).toBe('app-questionnaire/100-brand-contrast-agent');
  });
});
