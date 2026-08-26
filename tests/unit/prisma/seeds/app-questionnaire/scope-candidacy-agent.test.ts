import { describe, it, expect, vi } from 'vitest';

import scopeCandidacyAgentSeed from '@/prisma/seeds/app-questionnaire/089-scope-candidacy-agent';
import { QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/089-scope-candidacy-agent` seed.
 *
 * Contract:
 *  - resolves the service-account admin and fails loudly if absent;
 *  - upserts exactly one AiAgent keyed on the shared candidacy-check slug;
 *  - binds explicitly to openai/gpt-5.4-mini rather than resolving the routing
 *    tier — see below, and the seed's own docblock, for why;
 *  - is private (visibility internal), an app component (isSystem false),
 *    active, and budget-capped;
 *  - the `update` branch re-asserts isSystem and fills the binding ONLY when
 *    both fields are still empty, so an operator's choice survives a re-seed;
 *  - declares the path-derived SeedHistory key.
 *
 * The binding used to be empty on purpose, resolving the `routing` tier at call
 * time — which meant `gpt-4.1-nano`. Measured over the routing corpus that model
 * returned malformed JSON on roughly one call in six, and because candidacy is
 * fail-soft, both attempts failing meant an ingest silently skipped Conditional
 * Topics: no proposal, no AppAiRun row, no error. gpt-5.4-mini was clean on 60 of
 * 60 calls and faster, for $0.0009 an upload.
 */

/**
 * @param existingAgent what `aiAgent.findUnique` returns for the pre-seed row —
 *   `null` for a fresh database, or a partial row to model an existing one.
 */
function makeCtx(existingAgent: { model: string; provider: string } | null = null) {
  const findFirst = vi.fn().mockResolvedValue({ id: 'admin-1' });
  const upsert = vi.fn().mockResolvedValue({ id: 'agent-1' });
  const findUnique = vi.fn().mockResolvedValue(existingAgent);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { user: { findFirst }, aiAgent: { upsert, findUnique } },
    logger,
  } as unknown as SeedContext;

  return { ctx, findFirst, upsert, findUnique };
}

describe('app-questionnaire/089-scope-candidacy-agent seed', () => {
  it('upserts the candidacy-check agent bound, private, app-owned, budget-capped', async () => {
    const { ctx, upsert } = makeCtx();

    await scopeCandidacyAgentSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG });
    expect(arg.create.slug).toBe(QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG);
    // Explicit, not empty. An empty binding resolves the routing tier, and on this deployment that
    // is gpt-4.1-nano — the model whose malformed JSON silently disabled Conditional Topics.
    expect(arg.create.model).toBe('gpt-5.4-mini');
    expect(arg.create.provider).toBe('openai');
    // App component, not a platform/system agent.
    expect(arg.create.isSystem).toBe(false);
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.visibility).toBe('internal');
    expect(typeof arg.create.monthlyBudgetUsd).toBe('number');
    expect(arg.create.monthlyBudgetUsd).toBeGreaterThan(0);
    expect(arg.create.createdBy).toBe('admin-1');
  });

  it('fills the binding on re-seed when the existing row has never been configured', async () => {
    // The prod upgrade path: a database seeded before this agent had a model carries two empty
    // strings, which is what the fix has to reach. Without this the change ships to new databases
    // only, and every existing deployment keeps the model that caused the bug.
    const { ctx, upsert } = makeCtx({ model: '', provider: '' });

    await scopeCandidacyAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({
      isSystem: false,
      model: 'gpt-5.4-mini',
      provider: 'openai',
    });
  });

  // The counterpart, and the one that matters to a fork: a re-seed must not overwrite a model the
  // operator picked. The seed runner re-runs a unit on every source-hash change, so this fires far
  // more often than "on upgrade".
  it.each([
    ['a fully chosen binding', { model: 'claude-sonnet-5', provider: 'anthropic' }],
    // `provider` set with `model` empty means "this provider, tier default" — a deliberate
    // configuration, not an unconfigured row. Filling just the model would stamp an OpenAI id
    // over it, which is why the guard reads both fields rather than only the model.
    ['a provider-only binding', { model: '', provider: 'anthropic' }],
  ])('leaves %s alone on re-seed', async (_label, existing) => {
    const { ctx, upsert } = makeCtx(existing);

    await scopeCandidacyAgentSeed.run(ctx);

    expect(upsert.mock.calls[0][0].update).toEqual({ isSystem: false });
  });

  it('throws when no service-account admin exists', async () => {
    const { ctx, findFirst, upsert } = makeCtx();

    findFirst.mockResolvedValueOnce(null);

    await expect(scopeCandidacyAgentSeed.run(ctx)).rejects.toThrow(/admin/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('declares the path-derived seed unit name', () => {
    expect(scopeCandidacyAgentSeed.name).toBe('app-questionnaire/089-scope-candidacy-agent');
  });
});
