import { describe, it, expect, vi } from 'vitest';

import extractorAgentSeed from '@/prisma/seeds/app-questionnaire/002-extractor-agent';
import { QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/002-extractor-agent` seed.
 *
 * Contract:
 *  - resolves the service-account admin and fails loudly if absent;
 *  - upserts exactly one AiAgent keyed on the shared extractor slug;
 *  - ships provider-agnostic (empty model/provider) so it resolves dynamically;
 *  - is private (visibility internal), system-owned, budget-capped, KB-restricted;
 *  - the `update` branch only re-asserts isSystem so re-seeding preserves
 *    operator edits (model pin, budget change);
 *  - declares the path-derived SeedHistory key.
 */

function makeCtx() {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-1' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;

  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/002-extractor-agent seed', () => {
  it('upserts the extractor agent provider-agnostic, private, system-owned, budget-capped', async () => {
    const { ctx, upsert } = makeCtx();

    await extractorAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG });
    expect(arg.create.slug).toBe(QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG);
    // Empty strings → dynamic resolution via agent-resolver.ts.
    expect(arg.create.model).toBe('');
    expect(arg.create.provider).toBe('');
    expect(arg.create.isSystem).toBe(true);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(arg.create.knowledgeAccessMode).toBe('restricted');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('uses an idempotent update that only re-asserts isSystem', async () => {
    const { ctx, upsert } = makeCtx();

    await extractorAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: true });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeCtx();
    findFirst.mockResolvedValueOnce(null);

    await expect(extractorAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(extractorAgentSeed.name).toBe('app-questionnaire/002-extractor-agent');
  });
});
