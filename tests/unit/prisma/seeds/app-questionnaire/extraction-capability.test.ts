import { describe, it, expect, vi } from 'vitest';

import extractionCapabilitySeed from '@/prisma/seeds/app-questionnaire/003-extraction-capability';
import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/003-extraction-capability` seed.
 *
 * Contract:
 *  - upserts the AiCapability row keyed on the extractor slug, as an internal
 *    capability pointing at the registered handler class;
 *  - functionDefinition.name matches the slug (the dispatcher / LLM contract);
 *  - the `update` branch re-applies the code-owned fields (executionType,
 *    executionHandler, functionDefinition) and no operator-owned column (#545);
 *  - binds the capability to the extractor agent when the agent exists, and
 *    skips the binding (without throwing) when it doesn't;
 *  - declares the path-derived SeedHistory key.
 */

function makeCtx(opts: { agent?: { id: string } | null } = {}) {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-1' });
  const agentFindUnique = vi
    .fn()
    .mockResolvedValue(opts.agent === undefined ? { id: 'agent-1' } : opts.agent);
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

  return { ctx, capabilityUpsert, agentFindUnique, agentCapabilityUpsert, logger };
}

describe('app-questionnaire/003-extraction-capability seed', () => {
  it('upserts the internal capability pointing at the registered handler', async () => {
    const { ctx, capabilityUpsert } = makeCtx();

    await extractionCapabilitySeed.run(ctx);

    expect(capabilityUpsert).toHaveBeenCalledTimes(1);
    const arg = capabilityUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG });
    expect(arg.create.slug).toBe(EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG);
    expect(arg.create.executionType).toBe('internal');
    expect(arg.create.executionHandler).toBe(EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER);
    expect(arg.create.functionDefinition.name).toBe(
      EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG
    );
    expect(arg.create.isActive).toBe(true);
    // App component, not a platform/system capability.
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.category).toBe('app');
  });

  it('re-applies the code-owned fields on update, and nothing the operator owns', async () => {
    const { ctx, capabilityUpsert } = makeCtx();

    await extractionCapabilitySeed.run(ctx);

    // Code-owned fields track the capability class, so an edited definition has to
    // reach rows that already exist — a create-only write leaves the original schema
    // advertised to the model for ever (#545). Operator-owned columns must NOT be
    // written here: re-applying `isActive` would silently re-enable a capability an
    // operator disabled, and `name` / `description` would revert their edits.
    const { update } = capabilityUpsert.mock.calls[0][0];
    expect(update.isSystem).toBe(false);
    expect(update.executionType).toBe('internal');
    expect(update.executionHandler).toBe(EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER);
    expect(update.functionDefinition).toBeDefined();
    expect(Object.keys(update)).toEqual(
      expect.not.arrayContaining(['isActive', 'rateLimit', 'name', 'description', 'category'])
    );
  });

  it('binds the capability to the extractor agent when the agent exists', async () => {
    const { ctx, agentCapabilityUpsert } = makeCtx({ agent: { id: 'agent-1' } });

    await extractionCapabilitySeed.run(ctx);

    expect(agentCapabilityUpsert).toHaveBeenCalledTimes(1);
    const arg = agentCapabilityUpsert.mock.calls[0][0];
    // The composite idempotency key must target this agent+capability pair —
    // a wrong `where` would create duplicate bindings on re-seed instead of
    // being a no-op, and a `create`-only assertion would not catch it.
    expect(arg.where).toEqual({
      agentId_capabilityId: { agentId: 'agent-1', capabilityId: 'cap-1' },
    });
    expect(arg.create).toEqual({
      agentId: 'agent-1',
      capabilityId: 'cap-1',
      isEnabled: true,
    });
  });

  it('skips the binding without throwing when the extractor agent is missing', async () => {
    const { ctx, agentCapabilityUpsert, logger } = makeCtx({ agent: null });

    await expect(extractionCapabilitySeed.run(ctx)).resolves.toBeUndefined();
    expect(agentCapabilityUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(extractionCapabilitySeed.name).toBe('app-questionnaire/003-extraction-capability');
  });
});
