import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  ASSIGN_DATA_SLOTS_CAPABILITY_SLUG,
  ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION,
  ASSIGN_DATA_SLOTS_HANDLER,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the assign-orphans `AiCapability` row and bind it to the data-slot generator agent (Data
 * Slots feature). `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppAssignDataSlotsCapability` registered via `initAppCapabilities()`. App capability
 * (`category: 'app'`, `isSystem: false`). `rateLimit: null` — the route owns the per-admin sub-cap.
 * Idempotent. Runs after 029 (the agent) so the binding resolves.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/032-data-slots-assign-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire data-slot assignment capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: ASSIGN_DATA_SLOTS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: ASSIGN_DATA_SLOTS_CAPABILITY_SLUG,
        name: 'Assign Data Slots',
        description:
          'Places newly-added (unslotted) questions into a version’s existing data slots — or proposes new slots for genuinely distinct data points — via a provider-agnostic structured LLM call. Returns one placement per question; the caller merges deterministically and persists.',
        category: 'app',
        executionType: 'internal',
        executionHandler: ASSIGN_DATA_SLOTS_HANDLER,
        functionDefinition:
          ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
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
      `✅ Seeded ${ASSIGN_DATA_SLOTS_CAPABILITY_SLUG} capability${agent ? ' (bound to generator agent)' : ''}`
    );
  },
};

export default unit;
