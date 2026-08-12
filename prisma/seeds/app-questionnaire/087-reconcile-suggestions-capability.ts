import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
  RECONCILE_SUGGESTIONS_FUNCTION_DEFINITION,
  RECONCILE_SUGGESTIONS_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the cross-judge reconciliation `AiCapability` row.
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppReconcileSuggestionsCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to an agent row**, following its sibling `app_evaluate_structure`: `runEvaluationPanel`
 * dispatches it with the reconciler agent's binding passed through the dispatch context, so there is
 * no `aiAgentCapability` row. `rateLimit: null` at the capability layer — the evaluation routes
 * already own the meaningful per-admin sub-cap, and this adds one call to a run that costs seven.
 *
 * A ConQuest **app** capability (`category: 'app'`, `isSystem: false`): editable, deletable, and
 * included in config backup/export. Idempotent — `update` only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/087-reconcile-suggestions-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding the cross-judge reconciliation capability...');

    await prisma.aiCapability.upsert({
      where: { slug: RECONCILE_SUGGESTIONS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
        name: 'Reconcile Judge Suggestions',
        description:
          "Merges several independent judges' verdicts about the same questionnaire question into " +
          'one or two alternative phrasings that satisfy as many of their concerns as possible, ' +
          'naming the concerns each phrasing resolves and any that wording alone cannot. Dispatched ' +
          'once per evaluation run, after the judge panel.',
        category: 'app',
        executionType: 'internal',
        executionHandler: RECONCILE_SUGGESTIONS_HANDLER,
        // Trusted internal config (not external data) → cast at the storage boundary, as the
        // sibling capability seeds do.
        functionDefinition:
          RECONCILE_SUGGESTIONS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${RECONCILE_SUGGESTIONS_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
