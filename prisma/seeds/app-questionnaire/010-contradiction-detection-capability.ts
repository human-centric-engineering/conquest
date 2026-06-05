import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  DETECT_CONTRADICTIONS_FUNCTION_DEFINITION,
  DETECT_CONTRADICTIONS_HANDLER,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the contradiction-detector `AiCapability` row and bind it to the
 * contradiction-detector agent (F4.3).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppDetectContradictionsCapability` registered via
 * `initAppCapabilities()`. The binding to the detector agent is explicit (the
 * dispatcher would default-allow without it, but an explicit row makes the
 * relationship visible in the admin UI).
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`): it
 * shows under the admin "App" surface, stays editable/deletable, and is included in
 * config backup/export.
 *
 * `rateLimit: null` at the capability layer: the dispatcher's per-capability limiter
 * is keyed on the (shared) detector agent id, so a cap here would throttle all
 * admins together. The preview route owns the meaningful per-admin sub-cap.
 * Idempotent — `update` only re-asserts `isSystem: false` so re-seeding corrects any
 * stray system flag. Runs after `009-contradiction-detector-agent` (numeric order
 * within the directory), so the agent exists for the binding.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/010-contradiction-detection-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire contradiction-detection capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: DETECT_CONTRADICTIONS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
        name: 'Detect Contradictions',
        description:
          "Compares a respondent's captured answers across question slots and reports genuine logical contradictions (which slots conflict, why, a severity, and — under probe mode — a follow-up question), via a provider-agnostic structured LLM call. Surfaces conflicts; never overwrites.",
        category: 'app',
        executionType: 'internal',
        executionHandler: DETECT_CONTRADICTIONS_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON
        // input type at the storage boundary, as 003/007 do for their definitions.
        functionDefinition:
          DETECT_CONTRADICTIONS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG} agent not found — skipping capability binding (ensure 009-contradiction-detector-agent runs first).`
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
      `✅ Seeded ${DETECT_CONTRADICTIONS_CAPABILITY_SLUG} capability${agent ? ' (bound to contradiction-detector agent)' : ''}`
    );
  },
};

export default unit;
