import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
  VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION,
  VERIFY_EXTRACTION_STRUCTURE_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the verify-extraction `AiCapability` row (ingest verify + repair).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppVerifyExtractionStructureCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent** (like the design-evaluation capability): the ingest orchestrator
 * resolves the verifier agent's binding and passes it via the dispatch context, so there is no
 * `aiAgentCapability` row. A ConQuest **app** capability (`category: 'app'`, `isSystem: false`).
 * `rateLimit: null` — the ingest route already owns the per-admin sub-cap. Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/067-verify-extraction-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding questionnaire extraction-verifier capability...');

    await prisma.aiCapability.upsert({
      where: { slug: VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
        name: 'Verify Extracted Questionnaire',
        description:
          "Verifies an extracted questionnaire's questions against the source document, flagging " +
          'any whose answer type/config is unfaithful (mis-typed scale, missing likert anchors, ' +
          'flattened or row-lost rating grid). Returns per-question verdicts + detected grid spans; ' +
          'fixes nothing. Dispatched by the ingest orchestrator.',
        category: 'app',
        executionType: 'internal',
        executionHandler: VERIFY_EXTRACTION_STRUCTURE_HANDLER,
        functionDefinition:
          VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
