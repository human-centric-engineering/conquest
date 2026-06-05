import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
  REFINE_ANSWER_FUNCTION_DEFINITION,
  REFINE_ANSWER_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the answer-refiner `AiCapability` row and bind it to the answer-refiner agent
 * (F4.4).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppRefineAnswerCapability` registered via `initAppCapabilities()`. The
 * binding to the refiner agent is explicit (the dispatcher would default-allow
 * without it, but an explicit row makes the relationship visible in the admin UI).
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`): shows
 * under the admin "App" surface, stays editable/deletable, included in config
 * backup/export.
 *
 * `rateLimit: null` at the capability layer: the dispatcher's per-capability limiter
 * is keyed on the (shared) refiner agent id, so a cap here would throttle all admins
 * together. The route owns the meaningful per-admin sub-cap. Idempotent — `update`
 * only re-asserts `isSystem: false`. Runs after `012-answer-refiner-agent` (numeric
 * order within the directory), so the agent exists for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/013-answer-refinement-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire answer-refinement capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: REFINE_ANSWER_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: REFINE_ANSWER_CAPABILITY_SLUG,
        name: 'Refine Answer',
        description:
          "Decides whether a respondent's already-captured answers should be updated in light of new context — refine (the value evolved), overwrite (a mistaken capture), or leave — via a provider-agnostic structured LLM call. Returns decisions; the route applies and persists them.",
        category: 'app',
        executionType: 'internal',
        executionHandler: REFINE_ANSWER_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON
        // input type at the storage boundary, as 003/007/010 do for their definitions.
        functionDefinition: REFINE_ANSWER_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG} agent not found — skipping capability binding (ensure 012-answer-refiner-agent runs first).`
      );
    } else {
      await prisma.aiAgentCapability.upsert({
        where: {
          agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id },
        },
        update: {},
        create: {
          agentId: agent.id,
          capabilityId: capability.id,
          isEnabled: true,
        },
      });
    }

    logger.info(
      `✅ Seeded ${REFINE_ANSWER_CAPABILITY_SLUG} capability${agent ? ' (bound to answer-refiner agent)' : ''}`
    );
  },
};

export default unit;
