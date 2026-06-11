import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the data-slot generator agent. The load-bearing instructions are
 * assembled by `buildDataSlotGenerationPrompt` (data-slots/generation.ts); this makes the agent
 * self-describing in the admin UI.
 */
const DATA_SLOTS_AGENT_INSTRUCTIONS = `You design the DATA SLOTS for a conversational \
questionnaire: short (1–4 word) semantic targets, each with a description and a mapping to the \
question(s) it abstracts over. You consolidate related questions into well-described slots rather \
than copying questions 1:1, cover every question, and group slots under short themes. You output \
structured JSON only and never invent questions that aren't there.`;

/**
 * Seed the data-slot generator agent (Data Slots feature). Dispatched programmatically by the
 * generate-data-slots route. Empty model/provider → dynamic resolution (`reasoning` tier — it
 * reasons over the whole question set). Internal visibility; its own budget. App agent
 * (`isSystem: false`). Idempotent — `update` re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/029-data-slots-generator-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire data-slot generator agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Data-Slot Generator',
        slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
        description:
          'Infers the data slots (short semantic targets + descriptions + question mappings) that abstract over a questionnaire version’s questions. Dispatched by the generate-data-slots admin route; not a chat agent.',
        systemInstructions: DATA_SLOTS_AGENT_INSTRUCTIONS,
        model: '',
        provider: '',
        // A little latitude for naming/phrasing, but it must stay faithful to the questions.
        temperature: 0.4,
        maxTokens: 2048,
        monthlyBudgetUsd: 50,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG} agent`);
  },
};

export default unit;
