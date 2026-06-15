import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  COMPOSE_QUESTIONNAIRE_FUNCTION_DEFINITION,
  COMPOSE_QUESTIONNAIRE_HANDLER,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the compose-from-brief `AiCapability` row and bind it to the composer agent
 * (generative authoring).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppComposeQuestionnaireCapability` registered via `initAppCapabilities()`.
 * App capability (`category: 'app'`, `isSystem: false`): editable/deletable, included
 * in config backup/export. `rateLimit: null` at the capability layer (keyed on the
 * shared agent id); the routes own the per-admin sub-cap. Idempotent — `update` only
 * re-asserts `isSystem: false`. Runs after `036-composer-agent`, so the agent exists.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/037-compose-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire compose-from-brief capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
        name: 'Compose Questionnaire from Brief',
        description:
          'Composes an opinionated, structured questionnaire (sections, questions with inferred types, goal, audience) from a plain-English brief via a provider-agnostic structured LLM call. No source document; empty change log.',
        category: 'app',
        executionType: 'internal',
        executionHandler: COMPOSE_QUESTIONNAIRE_HANDLER,
        functionDefinition:
          COMPOSE_QUESTIONNAIRE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
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
      `✅ Seeded ${COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG} capability${agent ? ' (bound to composer agent)' : ''}`
    );
  },
};

export default unit;
