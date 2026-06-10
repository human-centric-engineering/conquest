import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  GENERATE_DATA_SLOTS_FUNCTION_DEFINITION,
  GENERATE_DATA_SLOTS_HANDLER,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the data-slot generation `AiCapability` row and bind it to the generator agent
 * (Data Slots feature). `executionType: 'internal'` + `executionHandler` points the dispatcher
 * at the in-memory `AppGenerateDataSlotsCapability` registered via `initAppCapabilities()`.
 * App capability (`category: 'app'`, `isSystem: false`). `rateLimit: null` — the route owns the
 * per-admin sub-cap. Idempotent. Runs after 029 so the agent exists for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/030-data-slots-generation-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire data-slot generation capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: GENERATE_DATA_SLOTS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
        name: 'Generate Data Slots',
        description:
          'Infers the semantic data slots (short names + descriptions + question mappings) that abstract over a questionnaire version’s questions, via a provider-agnostic structured LLM call. Persists nothing — the admin reviews the proposed slots.',
        category: 'app',
        executionType: 'internal',
        executionHandler: GENERATE_DATA_SLOTS_HANDLER,
        functionDefinition:
          GENERATE_DATA_SLOTS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG} agent not found — skipping capability binding (ensure 029 runs first).`
      );
    } else {
      await prisma.aiAgentCapability.upsert({
        where: { agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id } },
        update: {},
        create: { agentId: agent.id, capabilityId: capability.id, isEnabled: true },
      });
    }

    logger.info(
      `✅ Seeded ${GENERATE_DATA_SLOTS_CAPABILITY_SLUG} capability${agent ? ' (bound to generator agent)' : ''}`
    );
  },
};

export default unit;
