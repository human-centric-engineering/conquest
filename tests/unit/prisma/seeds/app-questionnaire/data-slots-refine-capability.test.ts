import { describe, it, expect, vi } from 'vitest';

import refineCapabilitySeed from '@/prisma/seeds/app-questionnaire/031-data-slots-refine-capability';
import {
  REFINE_DATA_SLOT_CAPABILITY_SLUG,
  REFINE_DATA_SLOT_HANDLER,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

function makeCtx(opts: { agent?: { id: string } | null } = {}) {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-refine' });
  const agentFindUnique = vi
    .fn()
    .mockResolvedValue(opts.agent === undefined ? { id: 'agent-ds' } : opts.agent);
  const agentCapabilityUpsert = vi.fn().mockResolvedValue({ id: 'binding-1' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: {
      aiCapability: { upsert: capabilityUpsert },
      aiAgent: { findUnique: agentFindUnique },
      aiAgentCapability: { upsert: agentCapabilityUpsert },
    },
    logger,
  } as unknown as SeedContext;
  return { ctx, capabilityUpsert, agentCapabilityUpsert, logger };
}

describe('app-questionnaire/031-data-slots-refine-capability seed', () => {
  it('upserts the internal capability pointing at the registered handler', async () => {
    const { ctx, capabilityUpsert } = makeCtx();
    await refineCapabilitySeed.run(ctx);
    const arg = capabilityUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: REFINE_DATA_SLOT_CAPABILITY_SLUG });
    expect(arg.create.executionType).toBe('internal');
    expect(arg.create.executionHandler).toBe(REFINE_DATA_SLOT_HANDLER);
    expect(arg.create.functionDefinition.name).toBe(REFINE_DATA_SLOT_CAPABILITY_SLUG);
    expect(arg.create.category).toBe('app');
    expect(arg.create.isSystem).toBe(false);
  });

  it('binds the capability to the generator agent when it exists', async () => {
    const { ctx, agentCapabilityUpsert } = makeCtx({ agent: { id: 'agent-ds' } });
    await refineCapabilitySeed.run(ctx);
    expect(agentCapabilityUpsert).toHaveBeenCalledWith({
      where: { agentId_capabilityId: { agentId: 'agent-ds', capabilityId: 'cap-refine' } },
      update: {},
      create: { agentId: 'agent-ds', capabilityId: 'cap-refine', isEnabled: true },
    });
  });

  it('skips the binding without throwing when the agent is missing', async () => {
    const { ctx, agentCapabilityUpsert, logger } = makeCtx({ agent: null });
    await expect(refineCapabilitySeed.run(ctx)).resolves.toBeUndefined();
    expect(agentCapabilityUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(refineCapabilitySeed.name).toBe('app-questionnaire/031-data-slots-refine-capability');
  });
});
