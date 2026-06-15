import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_COMPOSER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the composer agent. NOTE: the compose/refine
 * capabilities build their own structured prompts via `compose-prompt.ts` and do
 * NOT read these instructions — they exist so the agent is self-describing in the
 * admin UI and so any future chat-driven use of this agent has a sensible persona.
 * The load-bearing generation rules live in
 * `lib/app/questionnaire/ingestion/compose-prompt.ts`.
 */
const COMPOSER_INSTRUCTIONS = `You are the questionnaire composer for the ConQuest app. From a short \
plain-English brief you design a clean, well-structured conversational questionnaire — coherent \
sections, clear self-contained questions, and a sensible answer type for each — and you refine that \
structure on request ("make it shorter", "add a section on pricing"). You are decisive and concise: \
prefer the smallest set of questions that fully covers the brief's intent over an exhaustive one.`;

/**
 * Seed the questionnaire-composer agent (generative authoring).
 *
 * The compose + refine capabilities are dispatched programmatically against this
 * agent's id; the agent carries the budget cap and the provider-agnostic binding.
 * It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`. `visibility: 'internal'` keeps it off public/embed surfaces.
 * A distinct agent from the document extractor: composition and extraction carry
 * their own budgets and personas.
 *
 * App seed: `SeedHistory` key `app-questionnaire/036-composer-agent`. Idempotent —
 * the `update` branch only re-asserts `isSystem: false` so re-seeding corrects any
 * stray system flag without clobbering an operator's edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/036-composer-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire-composer agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Composer',
        slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        description:
          'Composes an opinionated, structured questionnaire (sections, questions, goal, audience) from a plain-English brief, and conversationally refines it. Dispatched by the generative-authoring API; not a chat agent.',
        systemInstructions: COMPOSER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Design wants coherence with a little room to be opinionated.
        temperature: 0.4,
        // Sections + questions is a verbose structured payload; reasoning models
        // split this cap with internal reasoning.
        maxTokens: 16384,
        // A safety ceiling on composition spend. The routes add a per-admin sub-cap;
        // this caps the shared agent's monthly total.
        monthlyBudgetUsd: 25,
        // The composer designs from the brief, not a knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_COMPOSER_AGENT_SLUG} agent`);
  },
};

export default unit;
