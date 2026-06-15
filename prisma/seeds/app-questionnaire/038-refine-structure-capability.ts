import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  REFINE_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION,
  REFINE_QUESTIONNAIRE_STRUCTURE_HANDLER,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the refine-questionnaire-structure `AiCapability` row and bind it to the
 * composer agent (generative authoring — the conversational-refine turn).
 *
 * Reuses the composer agent (refinement is the same design skill as composition).
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppRefineQuestionnaireStructureCapability`. App capability, idempotent
 * (`update` re-asserts `isSystem: false`). Runs after `036-composer-agent`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/038-refine-structure-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire refine-structure capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
        name: 'Refine Questionnaire Structure',
        description:
          'Applies a natural-language instruction to an existing questionnaire structure and returns the full updated structure plus a one-line summary of what changed. Provider-agnostic structured LLM call.',
        category: 'app',
        executionType: 'internal',
        executionHandler: REFINE_QUESTIONNAIRE_STRUCTURE_HANDLER,
        functionDefinition:
          REFINE_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_COMPOSER_AGENT_SLUG} agent not found — skipping capability binding (ensure 036-composer-agent runs first).`
      );
    } else {
      await prisma.aiAgentCapability.upsert({
        where: { agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id } },
        update: {},
        create: { agentId: agent.id, capabilityId: capability.id, isEnabled: true },
      });
    }

    logger.info(
      `✅ Seeded ${REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG} capability${agent ? ' (bound to composer agent)' : ''}`
    );
  },
};

export default unit;
