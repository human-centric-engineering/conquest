import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  REFINE_DATA_SLOT_CAPABILITY_SLUG,
  REFINE_DATA_SLOT_FUNCTION_DEFINITION,
  REFINE_DATA_SLOT_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the single-slot refinement `AiCapability` row and bind it to the data-slot generator agent
 * (Data Slots feature). `executionType: 'internal'` + `executionHandler` points the dispatcher at
 * the in-memory `AppRefineDataSlotCapability` registered via `initAppCapabilities()`. App
 * capability (`category: 'app'`, `isSystem: false`). `rateLimit: null` — the route owns the
 * per-admin sub-cap. Idempotent. Runs after 029 (the agent) so the binding resolves.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/031-data-slots-refine-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire data-slot refinement capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: REFINE_DATA_SLOT_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: REFINE_DATA_SLOT_CAPABILITY_SLUG,
        name: 'Refine Data Slot',
        description:
          'Refines a single data slot — its name, description, theme, and the question(s) it covers — according to the admin’s free-text instructions, re-grounded against the version’s full question set, via a provider-agnostic structured LLM call. Persists nothing — the admin reviews the one refined slot.',
        category: 'app',
        executionType: 'internal',
        executionHandler: REFINE_DATA_SLOT_HANDLER,
        functionDefinition:
          REFINE_DATA_SLOT_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
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
      `✅ Seeded ${REFINE_DATA_SLOT_CAPABILITY_SLUG} capability${agent ? ' (bound to generator agent)' : ''}`
    );
  },
};

export default unit;
