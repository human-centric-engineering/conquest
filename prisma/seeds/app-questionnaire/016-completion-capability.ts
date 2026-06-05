import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  COMPOSE_COMPLETION_OFFER_FUNCTION_DEFINITION,
  COMPOSE_COMPLETION_OFFER_HANDLER,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the completion-offer composer `AiCapability` row and bind it to the completion
 * agent (F4.5).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppComposeCompletionOfferCapability` registered via
 * `initAppCapabilities()`. The binding to the completion agent is explicit (the
 * dispatcher would default-allow without it, but an explicit row makes the
 * relationship visible in the admin UI).
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`): it
 * shows under the admin "App" surface, stays editable/deletable, and is included in
 * config backup/export.
 *
 * `rateLimit: null` at the capability layer: the dispatcher's per-capability limiter
 * is keyed on the (shared) completion agent id, so a cap here would throttle all
 * admins together. The preview route owns the meaningful per-admin sub-cap.
 * Idempotent — `update` only re-asserts `isSystem: false`. Runs after
 * `015-completion-agent` (numeric order within the directory), so the agent exists
 * for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/016-completion-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire completion-offer capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
        name: 'Compose Completion Offer',
        description:
          'Phrases the natural-language offer to submit a questionnaire (offer message, covered recap, optional remaining note) via a provider-agnostic structured LLM call, once the deterministic gate has decided the respondent is done. Wording only; never decides whether to offer.',
        category: 'app',
        executionType: 'internal',
        executionHandler: COMPOSE_COMPLETION_OFFER_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON
        // input type at the storage boundary, as 003/007/010 do for their definitions.
        functionDefinition:
          COMPOSE_COMPLETION_OFFER_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_COMPLETION_AGENT_SLUG} agent not found — skipping capability binding (ensure 015-completion-agent runs first).`
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
      `✅ Seeded ${COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG} capability${agent ? ' (bound to completion agent)' : ''}`
    );
  },
};

export default unit;
