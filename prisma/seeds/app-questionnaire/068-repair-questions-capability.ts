import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  REPAIR_QUESTIONS_CAPABILITY_SLUG,
  REPAIR_QUESTIONS_FUNCTION_DEFINITION,
  REPAIR_QUESTIONS_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the repair-questions `AiCapability` row (ingest verify + repair).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppRepairQuestionsCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent** (like the verifier capability): the ingest orchestrator resolves
 * the repair agent's binding and passes it via the dispatch context. A ConQuest **app** capability
 * (`category: 'app'`, `isSystem: false`). `rateLimit: null` — the ingest route owns the per-admin
 * sub-cap. Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/068-repair-questions-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire repair-questions capability...');

    await prisma.aiCapability.upsert({
      where: { slug: REPAIR_QUESTIONS_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: REPAIR_QUESTIONS_CAPABILITY_SLUG,
        name: 'Repair Extracted Questions',
        description:
          'Re-extracts a small set of flagged questions from a questionnaire, correcting their ' +
          'answer type and config against the source (mis-typed scale, missing likert anchors, or a ' +
          'flattened/mis-split rating grid → one matrix question). Returns corrected questions ' +
          'keyed to the originals; persists nothing. Dispatched by the ingest orchestrator.',
        category: 'app',
        executionType: 'internal',
        executionHandler: REPAIR_QUESTIONS_HANDLER,
        functionDefinition:
          REPAIR_QUESTIONS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${REPAIR_QUESTIONS_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
