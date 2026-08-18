import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG,
  ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION,
  ANALYSE_GLOSSARY_TERMS_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the analyse-glossary-terms `AiCapability` row (definitions / glossary, P16).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppAnalyseGlossaryTermsCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent** (like the verifier + design-evaluation capabilities): the
 * analysis route resolves the Glossary Analyst's binding and passes it via the dispatch context,
 * so there is no `aiAgentCapability` row. A ConQuest **app** capability (`category: 'app'`,
 * `isSystem: false`). `rateLimit: null` — the analysis route already owns the per-admin sub-cap.
 * Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/085-analyse-glossary-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding the glossary-analysis capability...');

    await prisma.aiCapability.upsert({
      where: { slug: ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG },
      update: {
        // Code-owned fields are re-applied so an edited definition reaches rows
        // that already exist; `name` / `description` / `category` / `isActive`
        // stay operator-owned. See `.context/database/seeding.md` (#545).
        isSystem: false,
        executionType: 'internal',
        executionHandler: ANALYSE_GLOSSARY_TERMS_HANDLER,
        functionDefinition:
          ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
      },
      create: {
        slug: ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG,
        name: 'Analyse Glossary Terms',
        description:
          'Analyses a questionnaire for terms that are ambiguous, contested, or context-dependent ' +
          'and proposes the readings it appears to intend — grounded in an admin-supplied ' +
          'definitions document when one is given. Returns candidates for an administrator to ' +
          'adjudicate; persists nothing and changes no questions.',
        category: 'app',
        executionType: 'internal',
        executionHandler: ANALYSE_GLOSSARY_TERMS_HANDLER,
        functionDefinition:
          ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
