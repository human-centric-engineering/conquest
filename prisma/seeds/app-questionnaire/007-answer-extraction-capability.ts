import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION,
  EXTRACT_ANSWER_SLOTS_HANDLER,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the answer-extractor `AiCapability` row and bind it to the answer-extractor
 * agent (F4.2).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppExtractAnswerSlotsCapability` registered via `initAppCapabilities()`.
 * The binding to the answer-extractor agent is explicit (the dispatcher would
 * default-allow without it, but an explicit row makes the relationship visible in
 * the admin UI).
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`): it
 * shows under the admin "App" surface, stays editable/deletable, and is included
 * in config backup/export.
 *
 * `rateLimit: null` at the capability layer: the dispatcher's per-capability
 * limiter is keyed on the (shared) answer-extractor agent id, so a cap here would
 * throttle all admins together. The preview route (PR3) owns the meaningful
 * per-admin sub-cap. Idempotent — `update` only re-asserts `isSystem: false` so
 * re-seeding corrects any stray system flag. Runs after `006-answer-extractor-agent`
 * (numeric order within the directory), so the agent exists for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/007-answer-extraction-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire answer-extraction capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
        name: 'Extract Answer Slots',
        description:
          "Extracts typed answer values from a respondent's message for one or more question slots (the active question plus side-effects), each with confidence, provenance, and rationale, via a provider-agnostic structured LLM call.",
        category: 'app',
        executionType: 'internal',
        executionHandler: EXTRACT_ANSWER_SLOTS_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON
        // input type at the storage boundary, as 003 does for its definition.
        // `parameters: Record<string, unknown>` isn't a structural
        // `InputJsonValue`, hence `unknown`.
        functionDefinition:
          EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG} agent not found — skipping capability binding (ensure 006-answer-extractor-agent runs first).`
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
      `✅ Seeded ${EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG} capability${agent ? ' (bound to answer-extractor agent)' : ''}`
    );
  },
};

export default unit;
