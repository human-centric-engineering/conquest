import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { AGENT_SETTINGS_ADVISOR_SLUG } from '@/lib/app/questionnaire/agent-advisory/explain-schema';

/**
 * System-prompt context for the Agent Settings Advisor. The "Explain with AI"
 * feature builds its own structured prompt via `explain-prompt.ts` and does NOT
 * read these instructions at runtime — they exist so the agent is self-describing
 * in the admin UI and gives any future chat use a sensible persona.
 */
const INSTRUCTIONS = `You are the Agent Settings Advisor for the ConQuest questionnaire platform. \
Given one agent's current model, temperature, maxTokens and reasoning effort, a deterministic \
baseline recommendation, and a cost trade-off, you explain in plain language whether the settings \
are a sensible cost/quality choice for that agent's role and propose the smallest high-value change \
(or none). The operator uses OpenAI; the GPT-5 family ignores temperature. You are concrete, \
reference the actual numbers, and never invent models or fields.`;

/**
 * Seed the Agent Settings Advisor agent (the hybrid "Explain with AI" layer of
 * the Agent Settings Evaluation surface).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts` (reasoning tier). `visibility: 'internal'` keeps it off
 * public/embed surfaces. Idempotent — the `update` branch only re-asserts
 * `isSystem: false` so re-seeding corrects a stray system flag without clobbering
 * operator edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/058-agent-settings-advisor',
  async run({ prisma, logger }) {
    logger.info('🎚️  Seeding Agent Settings Advisor agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: AGENT_SETTINGS_ADVISOR_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Agent Settings Advisor',
        slug: AGENT_SETTINGS_ADVISOR_SLUG,
        description:
          'Explains, on demand, whether a questionnaire agent’s model/temperature/effort settings ' +
          'are a sensible cost/quality choice and proposes a small applyable tweak. Dispatched by ' +
          'the Agent Settings “Explain with AI” API; not a chat agent.',
        systemInstructions: INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Grounded explanation; the GPT-5 family ignores this anyway.
        temperature: 0.3,
        // Narrative + a small JSON suggestion; reasoning models split this cap.
        maxTokens: 3072,
        // Safety ceiling on advisory spend.
        monthlyBudgetUsd: 10,
        // Reasons over the supplied settings snapshot, not a knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only.
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${AGENT_SETTINGS_ADVISOR_SLUG} agent`);
  },
};

export default unit;
