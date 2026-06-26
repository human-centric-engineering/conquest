import { describe, it, expect, vi } from 'vitest';

import advisorAgentSeed from '@/prisma/seeds/app-questionnaire/057-advisor-agent';
import { QUESTIONNAIRE_ADVISOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

function makeCtx() {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-advisor' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;
  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/057-advisor-agent seed', () => {
  it('upserts the advisor agent provider-agnostic, internal, app-owned, budget-capped', async () => {
    const { ctx, upsert } = makeCtx();
    await advisorAgentSeed.run(ctx);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG });
    expect(arg.create.model).toBe('');
    expect(arg.create.provider).toBe('');
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.visibility).toBe('internal');
    expect(arg.create.knowledgeAccessMode).toBe('restricted');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('re-asserts isSystem:false on the idempotent update branch', async () => {
    const { ctx, upsert } = makeCtx();
    await advisorAgentSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeCtx();
    findFirst.mockResolvedValueOnce(null);
    await expect(advisorAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(advisorAgentSeed.name).toBe('app-questionnaire/057-advisor-agent');
  });
});
