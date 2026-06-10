import { describe, it, expect, vi } from 'vitest';

import generatorAgentSeed from '@/prisma/seeds/app-questionnaire/029-data-slots-generator-agent';
import { QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

function makeCtx() {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-ds' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;
  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/029-data-slots-generator-agent seed', () => {
  it('upserts the generator agent provider-agnostic, private, app-owned, budget-capped', async () => {
    const { ctx, upsert } = makeCtx();
    await generatorAgentSeed.run(ctx);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG });
    expect(arg.create.model).toBe('');
    expect(arg.create.provider).toBe('');
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.visibility).toBe('internal');
    expect(arg.create.knowledgeAccessMode).toBe('restricted');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeCtx();
    findFirst.mockResolvedValueOnce(null);
    await expect(generatorAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(generatorAgentSeed.name).toBe('app-questionnaire/029-data-slots-generator-agent');
  });
});
