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
 *    binding at dispatch time instead);
 *  - the slug carries the feature's name, and the feature was renamed, so the
 *    row is renamed IN PLACE before the upsert — otherwise the upsert creates a
 *    second row and strands the operator's edits on the original.
 */

const LEGACY_SLUG = 'app_detect_adaptive_scope_candidacy';

/**
 * @param rows - which slugs the database already holds, in the order
 *   `[legacy, current]`, as `findUnique` will answer for each.
 */
function makeCtx(rows: { legacy?: { id: string } | null; current?: { id: string } | null } = {}) {
  const capabilityUpsert = vi.fn().mockResolvedValue({ id: 'cap-1' });
  const capabilityUpdate = vi.fn().mockResolvedValue({ id: 'cap-1' });
  const capabilityFindUnique = vi.fn(async ({ where }: { where: { slug: string } }) =>
    where.slug === LEGACY_SLUG ? (rows.legacy ?? null) : (rows.current ?? null)
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: {
      aiCapability: {
        upsert: capabilityUpsert,
        update: capabilityUpdate,
        findUnique: capabilityFindUnique,
      },
    },
    logger,
  } as unknown as SeedContext;

  return { ctx, capabilityUpsert, capabilityUpdate, capabilityFindUnique, logger };
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

  describe('the Adaptive Scope → Conditional Topics slug rename', () => {
    it('renames the pre-rename row in place, before the upsert can create a second one', async () => {
      const { ctx, capabilityUpdate, capabilityUpsert } = makeCtx({ legacy: { id: 'cap-legacy' } });

      await detectScopeCandidacyCapabilitySeed.run(ctx);

      expect(capabilityUpdate).toHaveBeenCalledWith({
        where: { id: 'cap-legacy' },
        data: { slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG },
      });
      // The rename has to land first, or the upsert misses the row it was meant to find.
      expect(capabilityUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        capabilityUpsert.mock.invocationCallOrder[0]
      );
      // Only the slug moves. `name` / `description` / `isActive` are the operator's, and 097
      // re-words them separately — a rename must not revert an operator's own wording.
      expect(Object.keys(capabilityUpdate.mock.calls[0][0].data)).toEqual(['slug']);
    });

    it('leaves a stranded legacy row alone and says so, when the new row already exists', async () => {
      const { ctx, capabilityUpdate, logger } = makeCtx({
        legacy: { id: 'cap-legacy' },
        current: { id: 'cap-1' },
      });

      await detectScopeCandidacyCapabilitySeed.run(ctx);

      // Renaming here would collide on the unique slug; 097 deactivates it instead.
      expect(capabilityUpdate).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stranded'));
    });

    it('does nothing on a database that never held the old slug', async () => {
      const { ctx, capabilityUpdate, capabilityUpsert } = makeCtx();

      await detectScopeCandidacyCapabilitySeed.run(ctx);

      expect(capabilityUpdate).not.toHaveBeenCalled();
      expect(capabilityUpsert).toHaveBeenCalledTimes(1);
    });
  });
});
