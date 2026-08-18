import { describe, it, expect, vi } from 'vitest';

import detectScopeCandidacyCapabilitySeed from '@/prisma/seeds/app-questionnaire/090-detect-scope-candidacy-capability';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  DETECT_SCOPE_CANDIDACY_HANDLER,
} from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/090-detect-scope-candidacy-capability` seed.
 *
 * Contract:
 *  - upserts the AiCapability row keyed on the candidacy-check slug, as an
 *    internal capability pointing at the registered handler class;
 *  - functionDefinition.name matches the slug (the dispatcher / LLM contract);
 *  - rateLimit is null — the ingest route already owns the per-admin sub-cap;
 *  - the `update` branch re-applies the code-owned fields (executionType,
 *    executionHandler, functionDefinition) and no operator-owned column (#545);
 *  - NOT bound to any agent — unlike 003-extraction-capability, this seed
 *    never touches `aiAgentCapability` (the ingest pipeline resolves the
 *    binding at dispatch time instead).
 */

function makeCtx() {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-1' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { aiCapability: { upsert: capabilityUpsert } },
    logger,
  } as unknown as SeedContext;

  return { ctx, capabilityUpsert };
}

describe('app-questionnaire/090-detect-scope-candidacy-capability seed', () => {
  it('upserts the internal capability pointing at the registered handler', async () => {
    const { ctx, capabilityUpsert } = makeCtx();

    await detectScopeCandidacyCapabilitySeed.run(ctx);

    expect(capabilityUpsert).toHaveBeenCalledTimes(1);
    const arg = capabilityUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG });
    expect(arg.create.slug).toBe(DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG);
    expect(arg.create.category).toBe('app');
    expect(arg.create.executionType).toBe('internal');
    expect(arg.create.executionHandler).toBe(DETECT_SCOPE_CANDIDACY_HANDLER);
    expect(arg.create.functionDefinition.name).toBe(DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG);
    expect(arg.create.rateLimit).toBeNull();
    expect(arg.create.isActive).toBe(true);
    // App component, not a platform/system capability.
    expect(arg.create.isSystem).toBe(false);
  });

  it('re-applies the code-owned fields on update, and nothing the operator owns', async () => {
    const { ctx, capabilityUpsert } = makeCtx();

    await detectScopeCandidacyCapabilitySeed.run(ctx);

    // Code-owned fields track the capability class, so an edited definition has to
    // reach rows that already exist — a create-only write leaves the original schema
    // advertised to the model for ever (#545). Operator-owned columns must NOT be
    // written here: re-applying `isActive` would silently re-enable a capability an
    // operator disabled, and `name` / `description` would revert their edits.
    const { update } = capabilityUpsert.mock.calls[0][0];
    expect(update.isSystem).toBe(false);
    expect(update.executionType).toBe('internal');
    expect(update.executionHandler).toBe(DETECT_SCOPE_CANDIDACY_HANDLER);
    expect(update.functionDefinition).toBeDefined();
    expect(Object.keys(update)).toEqual(
      expect.not.arrayContaining(['isActive', 'rateLimit', 'name', 'description', 'category'])
    );
  });
});
