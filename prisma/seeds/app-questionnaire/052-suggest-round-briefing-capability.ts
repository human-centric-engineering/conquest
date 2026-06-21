import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG,
  SUGGEST_ROUND_BRIEFING_FUNCTION_DEFINITION,
  SUGGEST_ROUND_BRIEFING_HANDLER,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the suggest-round-briefing `AiCapability` row and bind it to the composer agent (round
 * Additional Context, phase 3).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppSuggestRoundBriefingCapability` registered via `initAppCapabilities()`. App capability
 * (`category: 'app'`, `isSystem: false`): editable/deletable, included in config backup/export.
 * `rateLimit: null` at the capability layer (keyed on the shared agent id); the route owns the
 * per-admin sub-cap. Idempotent. Runs after the composer agent seed, so the agent exists.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/052-suggest-round-briefing-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding suggest-round-briefing capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG,
        name: 'Suggest Round Briefing',
        description:
          'Evaluates a questionnaire (+ optional admin source material) and proposes interviewer ' +
          '"briefing" notes — facts/figures/background that help the interviewer ask each question ' +
          'well, each optionally attributed to one question. Returns { entries }. The admin reviews ' +
          'and saves each via the normal create endpoint.',
        category: 'app',
        executionType: 'internal',
        executionHandler: SUGGEST_ROUND_BRIEFING_HANDLER,
        functionDefinition:
          SUGGEST_ROUND_BRIEFING_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
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
        `⚠️ ${QUESTIONNAIRE_COMPOSER_AGENT_SLUG} agent not found — skipping capability binding (ensure the composer-agent seed runs first).`
      );
    } else {
      await prisma.aiAgentCapability.upsert({
        where: { agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id } },
        update: {},
        create: { agentId: agent.id, capabilityId: capability.id, isEnabled: true },
      });
    }

    logger.info(
      `✅ Seeded ${SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG} capability${agent ? ' (bound to composer agent)' : ''}`
    );
  },
};

export default unit;
