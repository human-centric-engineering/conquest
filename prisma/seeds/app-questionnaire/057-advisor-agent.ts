import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_ADVISOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the advisor agent. NOTE: the advisor builds its own structured prompts
 * via `advisor-prompt.ts` and does NOT read these instructions at runtime — they exist so the agent
 * is self-describing in the admin UI and so any future chat-driven use has a sensible persona. The
 * load-bearing reasoning rules live in `lib/app/questionnaire/advisor/advisor-prompt.ts`.
 */
const ADVISOR_INSTRUCTIONS = `You are the questionnaire Config Advisor for the ConQuest app. Given a \
questionnaire's goal, structure, run-time configuration, and lifecycle state, you evaluate whether \
the settings cohere — flagging conflicts and choices that would hurt the respondent experience — and \
you describe, in plain language, the experience the current configuration actually produces. You are \
concrete and decisive: you reference specific settings by name, explain the effect of each, and \
propose the smallest set of high-value tweaks rather than an exhaustive list. You never invent \
settings that don't exist.`;

/**
 * Seed the Config Advisor agent.
 *
 * The advisor stream route loads this agent by id for the provider-agnostic binding + cost
 * attribution. It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`. `visibility: 'internal'` keeps it off public/embed surfaces. A distinct
 * agent from the composer/extractor: evaluation carries its own budget and persona.
 *
 * App seed: `SeedHistory` key `app-questionnaire/057-advisor-agent`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false` so re-seeding corrects any stray system flag without
 * clobbering an operator's edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/057-advisor-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire Config Advisor agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Config Advisor',
        slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
        description:
          'Evaluates a questionnaire’s whole configuration (structure, goal/audience, run-time ' +
          'config, data slots, scoring) and produces a narrative of the respondent experience plus ' +
          'one-click config-tweak suggestions. Dispatched by the advisor stream API; not a chat agent.',
        systemInstructions: ADVISOR_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // A little room to be opinionated in the narrative, but grounded.
        temperature: 0.4,
        // The narrative + structured suggestions are a modest payload; reasoning models split this
        // cap with internal reasoning.
        maxTokens: 8192,
        // A safety ceiling on advisory spend. The route adds a per-admin sub-cap; this caps the
        // shared agent's monthly total.
        monthlyBudgetUsd: 15,
        // The advisor reasons over the supplied config, not a knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_ADVISOR_AGENT_SLUG} agent`);
  },
};

export default unit;
