import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG,
  AUTHOR_INTRO_BACKGROUND_FUNCTION_DEFINITION,
  AUTHOR_INTRO_BACKGROUND_HANDLER,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the author-intro-background `AiCapability` row and bind it to the composer agent (F12.2).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppAuthorIntroBackgroundCapability` registered via `initAppCapabilities()`. App capability
 * (`category: 'app'`, `isSystem: false`): editable/deletable, included in config backup/export.
 * `rateLimit: null` at the capability layer (keyed on the shared agent id); the route owns the
 * per-admin sub-cap. Idempotent. Runs after `036-composer-agent`, so the agent exists.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/049-author-intro-background-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding respondent intro-background author capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG,
        name: 'Author Respondent Intro Background',
        description:
          'Generates or refines the respondent-facing "about this questionnaire" intro markdown via a provider-agnostic structured LLM call. generate = from a brief; refine = rewrite supplied text per an instruction. Returns { background }.',
        category: 'app',
        executionType: 'internal',
        executionHandler: AUTHOR_INTRO_BACKGROUND_HANDLER,
        functionDefinition:
          AUTHOR_INTRO_BACKGROUND_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
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
      `✅ Seeded ${AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG} capability${agent ? ' (bound to composer agent)' : ''}`
    );
  },
};

export default unit;
