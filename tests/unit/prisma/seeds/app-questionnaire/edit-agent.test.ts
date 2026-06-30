import { describe, it, expect, vi } from 'vitest';

import editAgentSeed from '@/prisma/seeds/app-questionnaire/060-edit-agent';
import editAgentFlagSeed from '@/prisma/seeds/app-questionnaire/059-edit-agent-flag';
import {
  QUESTIONNAIRE_EDIT_AGENT_SLUG,
  APP_QUESTIONNAIRES_EDIT_AGENT_FLAG,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

function makeAgentCtx() {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-edit' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;
  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/060-edit-agent seed', () => {
  it('upserts the edit agent provider-agnostic, internal, app-owned, budget-capped', async () => {
    const { ctx, upsert } = makeAgentCtx();
    await editAgentSeed.run(ctx);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_EDIT_AGENT_SLUG });
    expect(arg.create.model).toBe('');
    expect(arg.create.provider).toBe('');
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.visibility).toBe('internal');
    expect(arg.create.knowledgeAccessMode).toBe('restricted');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('re-asserts isSystem:false on the idempotent update branch', async () => {
    const { ctx, upsert } = makeAgentCtx();
    await editAgentSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeAgentCtx();
    findFirst.mockResolvedValueOnce(null);
    await expect(editAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(editAgentSeed.name).toBe('app-questionnaire/060-edit-agent');
  });
});

describe('app-questionnaire/059-edit-agent-flag seed', () => {
  function makeFlagCtx() {
    const upsert = vi.fn().mockResolvedValue({ id: 'flag-1' });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = { prisma: { featureFlag: { upsert } }, logger } as unknown as SeedContext;
    return { ctx, upsert };
  }

  it('upserts the edit-agent flag DISABLED by default', async () => {
    const { ctx, upsert } = makeFlagCtx();
    await editAgentFlagSeed.run(ctx);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: APP_QUESTIONNAIRES_EDIT_AGENT_FLAG });
    expect(arg.create.enabled).toBe(false);
  });

  it('is idempotent — the update branch does not flip the operator’s toggle', async () => {
    const { ctx, upsert } = makeFlagCtx();
    await editAgentFlagSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it('declares the path-derived seed unit name', () => {
    expect(editAgentFlagSeed.name).toBe('app-questionnaire/059-edit-agent-flag');
  });
});
