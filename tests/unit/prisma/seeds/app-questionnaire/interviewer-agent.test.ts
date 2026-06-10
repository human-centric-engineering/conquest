import { describe, it, expect, vi } from 'vitest';

import interviewerAgentSeed from '@/prisma/seeds/app-questionnaire/026-interviewer-agent';
import { QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/026-interviewer-agent` seed.
 *
 * Contract (mirrors the other questionnaire agent seeds):
 *  - resolves the service-account admin and fails loudly if absent;
 *  - upserts exactly one AiAgent keyed on the interviewer slug;
 *  - ships provider-agnostic (empty model/provider) so it resolves dynamically;
 *  - is private (visibility internal), an app component (isSystem false), budget-capped,
 *    KB-restricted;
 *  - the `update` branch only re-asserts isSystem;
 *  - declares the path-derived SeedHistory key.
 */
function makeCtx() {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-int' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert } },
    logger,
  } as unknown as SeedContext;
  return { ctx, findFirst, upsert };
}

describe('app-questionnaire/026-interviewer-agent seed', () => {
  it('upserts the interviewer agent provider-agnostic, private, app-owned, budget-capped', async () => {
    const { ctx, upsert } = makeCtx();
    await interviewerAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG });
    expect(arg.create.slug).toBe(QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG);
    expect(arg.create.model).toBe('');
    expect(arg.create.provider).toBe('');
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(arg.create.knowledgeAccessMode).toBe('restricted');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('uses an idempotent update that only re-asserts isSystem', async () => {
    const { ctx, upsert } = makeCtx();
    await interviewerAgentSeed.run(ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeCtx();
    findFirst.mockResolvedValueOnce(null);
    await expect(interviewerAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(interviewerAgentSeed.name).toBe('app-questionnaire/026-interviewer-agent');
  });
});
