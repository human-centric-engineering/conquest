import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  EVALUATE_SCOPE_CAPABILITY_SLUG,
  EVALUATE_SCOPE_FUNCTION_DEFINITION,
  EVALUATE_SCOPE_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the evaluate-scope `AiCapability` row (F17.21).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppEvaluateScopeCapability` registered via `initAppCapabilities()` — the sibling of
 * `020-design-evaluation-capability.ts` for Conditional Topics' own judge panel.
 *
 * **Not bound to any one agent.** Dispatched once per dimension against a *different* judge agent
 * each time — the route resolves the four judge bindings and passes each via the dispatch context.
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`).
 *
 * `rateLimit: null` at the capability layer: the scope evaluate-preview route owns the meaningful
 * per-admin sub-cap. Idempotent — `update` only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/092-scope-evaluation-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding Conditional Topics evaluation capability...');

    await prisma.aiCapability.upsert({
      where: { slug: EVALUATE_SCOPE_CAPABILITY_SLUG },
      update: {
        // Code-owned fields are re-applied so an edited definition reaches rows that already
        // exist; `name` / `description` / `category` / `isActive` stay operator-owned.
        isSystem: false,
        executionType: 'internal',
        executionHandler: EVALUATE_SCOPE_HANDLER,
        functionDefinition: EVALUATE_SCOPE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
      },
      create: {
        slug: EVALUATE_SCOPE_CAPABILITY_SLUG,
        name: 'Evaluate Conditional Topics',
        description:
          "Judges one dimension of a questionnaire version's Conditional Topics configuration (criteria quality, rule integrity, budget realism, or coverage and burden) via a provider-agnostic structured LLM call, returning a score and actionable findings. Dispatched once per dimension by the scope evaluate-preview route.",
        category: 'app',
        executionType: 'internal',
        executionHandler: EVALUATE_SCOPE_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON input type at
        // the storage boundary, as the F4/F5 capability seeds do.
        functionDefinition: EVALUATE_SCOPE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${EVALUATE_SCOPE_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
