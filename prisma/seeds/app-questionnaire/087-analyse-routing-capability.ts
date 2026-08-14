import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  ANALYSE_ROUTING_CAPABILITY_SLUG,
  ANALYSE_ROUTING_FUNCTION_DEFINITION,
  ANALYSE_ROUTING_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the analyse-routing `AiCapability` row — the Routing Analyst (Adaptive Scope, P17.4).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppAnalyseRoutingCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent** (like the glossary, verifier and design-evaluation capabilities):
 * the analysis route resolves the Routing Analyst's binding and passes it via the dispatch context,
 * so there is no `aiAgentCapability` row. A ConQuest **app** capability (`category: 'app'`,
 * `isSystem: false`). `rateLimit: null` — the analysis route owns the per-admin sub-cap, which
 * matters more here than for most capabilities: this call carries an entire source document.
 * Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/087-analyse-routing-capability',
  async run({ prisma, logger }) {
    logger.info('🧭 Seeding the routing-analysis capability...');

    await prisma.aiCapability.upsert({
      where: { slug: ANALYSE_ROUTING_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: ANALYSE_ROUTING_CAPABILITY_SLUG,
        name: 'Analyse Routing',
        description:
          'Reads an uploaded assessment instrument — especially the instruction pages structure ' +
          'extraction ignores — and proposes the topics it implies: which groups of questions ' +
          'always run, which are conditional, and the author’s own criteria for each. Returns a ' +
          'proposal for an administrator to review; persists nothing and changes no questions.',
        category: 'app',
        executionType: 'internal',
        executionHandler: ANALYSE_ROUTING_HANDLER,
        functionDefinition: ANALYSE_ROUTING_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${ANALYSE_ROUTING_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
