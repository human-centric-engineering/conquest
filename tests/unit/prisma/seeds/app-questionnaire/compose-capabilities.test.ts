import { describe, it, expect, vi } from 'vitest';

import composeSeed from '@/prisma/seeds/app-questionnaire/037-compose-capability';
import refineSeed from '@/prisma/seeds/app-questionnaire/038-refine-structure-capability';
import {
  COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  COMPOSE_QUESTIONNAIRE_HANDLER,
  REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  REFINE_QUESTIONNAIRE_STRUCTURE_HANDLER,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext, SeedUnit } from '@/prisma/runner';

function makeCtx(opts: { agent?: { id: string } | null } = {}) {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-1' });
  const agentFindUnique = vi
    .fn()
    .mockResolvedValue(opts.agent === undefined ? { id: 'agent-composer' } : opts.agent);
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

interface Case {
  seed: SeedUnit;
  name: string;
  slug: string;
  handler: string;
}

const CASES: Case[] = [
  {
    seed: composeSeed,
    name: 'app-questionnaire/037-compose-capability',
    slug: COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
    handler: COMPOSE_QUESTIONNAIRE_HANDLER,
  },
  {
    seed: refineSeed,
    name: 'app-questionnaire/038-refine-structure-capability',
    slug: REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
    handler: REFINE_QUESTIONNAIRE_STRUCTURE_HANDLER,
  },
];

describe.each(CASES)('$name seed', ({ seed, name, slug, handler }) => {
  it('upserts the internal capability pointing at the registered handler', async () => {
    const { ctx, capabilityUpsert } = makeCtx();
    await seed.run(ctx);
    const arg = capabilityUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug });
    expect(arg.create.executionType).toBe('internal');
    expect(arg.create.executionHandler).toBe(handler);
    expect(arg.create.functionDefinition.name).toBe(slug);
    expect(arg.create.category).toBe('app');
    expect(arg.create.isSystem).toBe(false);
  });

  it('binds the capability to the composer agent when it exists', async () => {
    const { ctx, agentCapabilityUpsert } = makeCtx({ agent: { id: 'agent-composer' } });
    await seed.run(ctx);
    expect(agentCapabilityUpsert).toHaveBeenCalledWith({
      where: { agentId_capabilityId: { agentId: 'agent-composer', capabilityId: 'cap-1' } },
      update: {},
      create: { agentId: 'agent-composer', capabilityId: 'cap-1', isEnabled: true },
    });
  });

  it('skips the binding without throwing when the agent is missing', async () => {
    const { ctx, agentCapabilityUpsert, logger } = makeCtx({ agent: null });
    await expect(seed.run(ctx)).resolves.toBeUndefined();
    expect(agentCapabilityUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(seed.name).toBe(name);
  });
});
