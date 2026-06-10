import { describe, it, expect, vi } from 'vitest';

import generationCapabilitySeed from '@/prisma/seeds/app-questionnaire/030-data-slots-generation-capability';
import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  GENERATE_DATA_SLOTS_HANDLER,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

function makeCtx(opts: { agent?: { id: string } | null } = {}) {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-ds' });
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

describe('app-questionnaire/030-data-slots-generation-capability seed', () => {
  it('upserts the internal capability pointing at the registered handler', async () => {
    const { ctx, capabilityUpsert } = makeCtx();
    await generationCapabilitySeed.run(ctx);
    const arg = capabilityUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: GENERATE_DATA_SLOTS_CAPABILITY_SLUG });
    expect(arg.create.executionType).toBe('internal');
    expect(arg.create.executionHandler).toBe(GENERATE_DATA_SLOTS_HANDLER);
    expect(arg.create.functionDefinition.name).toBe(GENERATE_DATA_SLOTS_CAPABILITY_SLUG);
    expect(arg.create.category).toBe('app');
    expect(arg.create.isSystem).toBe(false);
  });

  it('binds the capability to the generator agent when it exists', async () => {
    const { ctx, agentCapabilityUpsert } = makeCtx({ agent: { id: 'agent-ds' } });
    await generationCapabilitySeed.run(ctx);
    expect(agentCapabilityUpsert).toHaveBeenCalledWith({
      where: { agentId_capabilityId: { agentId: 'agent-ds', capabilityId: 'cap-ds' } },
      update: {},
      create: { agentId: 'agent-ds', capabilityId: 'cap-ds', isEnabled: true },
    });
  });

  it('skips the binding without throwing when the agent is missing', async () => {
    const { ctx, agentCapabilityUpsert, logger } = makeCtx({ agent: null });
    await expect(generationCapabilitySeed.run(ctx)).resolves.toBeUndefined();
    expect(agentCapabilityUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(generationCapabilitySeed.name).toBe(
      'app-questionnaire/030-data-slots-generation-capability'
    );
  });
});
