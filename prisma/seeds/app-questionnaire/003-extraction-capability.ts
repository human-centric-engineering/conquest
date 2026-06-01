import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  EXTRACT_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION,
  EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the extractor `AiCapability` row and bind it to the extractor agent
 * (F1.1 / PR3).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppExtractQuestionnaireStructureCapability` registered via
 * `initAppCapabilities()`. The binding to the extractor agent is explicit (the
 * dispatcher would default-allow without it, but an explicit row makes the
 * relationship visible in the admin UI and matches the system-agent seed
 * pattern).
 *
 * `rateLimit: null` at the capability layer: the dispatcher's per-capability
 * limiter is keyed on the (shared) extractor agent id, so a cap here would
 * throttle all admins together. PR4's ingestion route owns the meaningful
 * per-admin sub-cap. Idempotent — `update` only re-asserts `isSystem: true`.
 * Runs after `002-extractor-agent` (numeric order within the directory), so the
 * agent exists for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/003-extraction-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire extraction capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG },
      update: { isSystem: true },
      create: {
        slug: EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
        name: 'Extract Questionnaire Structure',
        description:
          'Extracts an opinionated, structured questionnaire (sections, questions, goal, audience) plus a revertible editorial change log from parsed document text via a provider-agnostic structured LLM call.',
        category: 'app',
        executionType: 'internal',
        executionHandler: EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON
        // input type at the storage boundary, as 010-model-auditor does for its
        // workflow definition. `parameters: Record<string, unknown>` isn't a
        // structural `InputJsonValue`, hence `unknown`.
        functionDefinition:
          EXTRACT_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: true,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG} agent not found — skipping capability binding (ensure 002-extractor-agent runs first).`
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
      `✅ Seeded ${EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG} capability${agent ? ' (bound to extractor agent)' : ''}`
    );
  },
};

export default unit;
