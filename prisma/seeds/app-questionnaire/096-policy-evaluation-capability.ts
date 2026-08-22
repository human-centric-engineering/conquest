import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  EVALUATE_POLICY_CAPABILITY_SLUG,
  EVALUATE_POLICY_FUNCTION_DEFINITION,
  EVALUATE_POLICY_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the evaluate-policy `AiCapability` row (F18.8).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppEvaluatePolicyCapability` registered via `initAppCapabilities()` — the third of its kind,
 * after `020-design-evaluation-capability.ts` (question design) and `092` (routing design).
 *
 * **Not bound to any one agent.** Dispatched once per dimension against a *different* judge agent
 * each time — the route resolves the four judge bindings and passes each via the dispatch context.
 *
 * This is a ConQuest **app** capability (`category: 'app'`, `isSystem: false`).
 *
 * `rateLimit: null` at the capability layer: the policy evaluate-preview route owns the meaningful
 * per-admin sub-cap. Idempotent — `update` only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/096-policy-evaluation-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding interviewer-policy evaluation capability...');

    await prisma.aiCapability.upsert({
      where: { slug: EVALUATE_POLICY_CAPABILITY_SLUG },
      update: {
        // Code-owned fields are re-applied so an edited definition reaches rows that already
        // exist; `name` / `description` / `category` / `isActive` stay operator-owned.
        isSystem: false,
        executionType: 'internal',
        executionHandler: EVALUATE_POLICY_HANDLER,
        functionDefinition: EVALUATE_POLICY_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
      },
      create: {
        slug: EVALUATE_POLICY_CAPABILITY_SLUG,
        name: 'Evaluate Interviewer Policy',
        description:
          "Judges one dimension of a questionnaire version's interviewer policy (rule coherence, arc fit, fidelity calibration, or cross-layer conflict) — its house rules, questioning arc, and per-question ask-as-written dial — via a provider-agnostic structured LLM call, returning a score and actionable findings. Dispatched once per dimension by the policy evaluate-preview route.",
        category: 'app',
        executionType: 'internal',
        executionHandler: EVALUATE_POLICY_HANDLER,
        // Trusted internal config (not external data) → cast to the Prisma JSON input type at
        // the storage boundary, as the F4/F5 capability seeds do.
        functionDefinition: EVALUATE_POLICY_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        // App component, not a platform/system capability.
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${EVALUATE_POLICY_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
