import { describe, it, expect, vi } from 'vitest';

import conditionalTopicsRenameSeed from '@/prisma/seeds/app-questionnaire/097-conditional-topics-rename';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  EVALUATE_SCOPE_CAPABILITY_SLUG,
  QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { SCOPE_EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `app-questionnaire/097-conditional-topics-rename` seed.
 *
 * Contract:
 *  - deactivates a stranded pre-rename capability row (the one case `090`'s
 *    in-place rename cannot reach), and only while it is still active;
 *  - re-words the old feature name out of `name` / `description` /
 *    `systemInstructions` on the rows `089`–`092` own, by SUBSTRING replacement
 *    rather than re-stamping from code — an operator who rewrote the text keeps
 *    their wording and still gets the new name;
 *  - repairs the article the substitution breaks ("an Adaptive Scope" is
 *    grammatical; "an Conditional Topics" is not);
 *  - writes nothing when there is nothing to rename, so a fresh database and a
 *    second run are both no-ops.
 */

const LEGACY_SLUG = 'app_detect_adaptive_scope_candidacy';

type AgentRow = {
  id: string;
  name: string;
  description: string;
  systemInstructions: string;
};

function makeCtx(
  rows: {
    agents?: Record<string, AgentRow>;
    capabilities?: Record<string, Omit<AgentRow, 'systemInstructions'>>;
  } = {}
) {
  const capabilityUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const agentUpdate = vi.fn().mockResolvedValue({});
  const capabilityUpdate = vi.fn().mockResolvedValue({});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: {
      aiCapability: {
        updateMany: capabilityUpdateMany,
        update: capabilityUpdate,
        findUnique: vi.fn(
          async ({ where }: { where: { slug: string } }) => rows.capabilities?.[where.slug] ?? null
        ),
      },
      aiAgent: {
        update: agentUpdate,
        findUnique: vi.fn(
          async ({ where }: { where: { slug: string } }) => rows.agents?.[where.slug] ?? null
        ),
      },
    },
    logger,
  } as unknown as SeedContext;

  return { ctx, capabilityUpdateMany, agentUpdate, capabilityUpdate, logger };
}

describe('app-questionnaire/097-conditional-topics-rename seed', () => {
  it('deactivates a stranded pre-rename capability row, and only an active one', async () => {
    const { ctx, capabilityUpdateMany } = makeCtx();

    await conditionalTopicsRenameSeed.run(ctx);

    expect(capabilityUpdateMany).toHaveBeenCalledWith({
      where: { slug: LEGACY_SLUG, isActive: true },
      data: { isActive: false },
    });
  });

  it('re-words the old name out of an agent, article included', async () => {
    const { ctx, agentUpdate } = makeCtx({
      agents: {
        [QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG]: {
          id: 'agent-1',
          name: 'Adaptive Scope Candidacy Check',
          description: 'Flags a questionnaire as an Adaptive Scope candidate.',
          systemInstructions: 'You judge the ADAPTIVE SCOPE configuration for adaptive scope fit.',
        },
      },
    });

    await conditionalTopicsRenameSeed.run(ctx);

    expect(agentUpdate).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: {
        name: 'Conditional Topics Candidacy Check',
        // "an Adaptive Scope" → "a Conditional Topics": the new name does not start with a vowel
        // sound, so a straight substitution would leave a grammatical error in operator-facing text.
        description: 'Flags a questionnaire as a Conditional Topics candidate.',
        systemInstructions:
          'You judge the CONDITIONAL TOPICS configuration for conditional topics fit.',
      },
    });
  });

  it('preserves an operator rewrite around the renamed phrase', async () => {
    const { ctx, capabilityUpdate } = makeCtx({
      capabilities: {
        [EVALUATE_SCOPE_CAPABILITY_SLUG]: {
          id: 'cap-eval',
          name: 'Evaluate Adaptive Scope',
          description: 'OUR house rule: judge the Adaptive Scope config, then stop.',
        },
      },
    });

    await conditionalTopicsRenameSeed.run(ctx);

    expect(capabilityUpdate).toHaveBeenCalledWith({
      where: { id: 'cap-eval' },
      data: {
        name: 'Evaluate Conditional Topics',
        // Everything the operator wrote around the feature name survives verbatim.
        description: 'OUR house rule: judge the Conditional Topics config, then stop.',
      },
    });
  });

  it('writes nothing when a row no longer mentions the old name', async () => {
    const { ctx, agentUpdate, capabilityUpdate } = makeCtx({
      agents: Object.fromEntries(
        [QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG, ...SCOPE_EVALUATION_JUDGE_SLUGS].map((slug) => [
          slug,
          {
            id: slug,
            name: 'Conditional Topics Candidacy Check',
            description: 'Already renamed.',
            systemInstructions: 'Already renamed.',
          },
        ])
      ),
      capabilities: {
        [DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG]: {
          id: 'cap-1',
          name: 'Detect Conditional Topics Candidacy',
          description: 'Already renamed.',
        },
      },
    });

    await conditionalTopicsRenameSeed.run(ctx);

    // Idempotence is what makes this safe to leave in the seed set for ever.
    expect(agentUpdate).not.toHaveBeenCalled();
    expect(capabilityUpdate).not.toHaveBeenCalled();
  });
});
