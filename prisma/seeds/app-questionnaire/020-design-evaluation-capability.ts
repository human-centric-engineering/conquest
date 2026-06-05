import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  EVALUATE_STRUCTURE_CAPABILITY_SLUG,
  EVALUATE_STRUCTURE_FUNCTION_DEFINITION,
  EVALUATE_STRUCTURE_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the evaluate-structure `AiCapability` row (F5.1).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the
 * in-memory `AppEvaluateStructureCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent.** Unlike the F4 capabilities (each bound to its single
 * agent), this capability is dispatched once per dimension against a *different* judge
 * agent each time — the route resolves the seven judge bindings and passes each via the
 * dispatch context. So there is no `aiAgentCapability` row here; the capability is a
 * shared internal handler, not a tool on a specific agent.
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`): it shows
 * under the admin "App" surface, stays editable/deletable, and is included in config
 * backup/export.
 *
 * `rateLimit: null` at the capability layer: the evaluate-preview route owns the
 * meaningful per-admin sub-cap (a run is seven calls). Idempotent — `update` only
 * re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/020-design-evaluation-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire design-evaluation capability...');

    await prisma.aiCapability.upsert({
      where: { slug: EVALUATE_STRUCTURE_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: EVALUATE_STRUCTURE_CAPABILITY_SLUG,
        name: 'Evaluate Questionnaire Structure',
        description:
          "Judges one dimension of a questionnaire version's structure (clarity, coverage, duplicates, type fit, ordering, audience match, or goal match) against its goal and audience via a provider-agnostic structured LLM call, returning a score and actionable findings. Dispatched once per dimension by the evaluate-preview route.",
        category: 'app',
        executionType: 'internal',
        executionHandler: EVALUATE_STRUCTURE_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON input
        // type at the storage boundary, as the F4 capability seeds do.
        functionDefinition:
          EVALUATE_STRUCTURE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${EVALUATE_STRUCTURE_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
