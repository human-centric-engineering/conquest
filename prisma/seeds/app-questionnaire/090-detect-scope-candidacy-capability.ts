import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION,
  DETECT_SCOPE_CANDIDACY_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the Adaptive Scope candidacy-check `AiCapability` row (P17.19).
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppDetectScopeCandidacyCapability` registered via `initAppCapabilities()`.
 *
 * **Not bound to any one agent** (like the extraction verifier and the Routing Analyst): the ingest
 * pipeline resolves the candidacy-check agent's binding and passes it via the dispatch context, so
 * there is no `aiAgentCapability` row. A ConQuest **app** capability (`category: 'app'`,
 * `isSystem: false`). `rateLimit: null` — the ingest route already owns the per-admin sub-cap.
 * Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/090-detect-scope-candidacy-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding Adaptive Scope candidacy-check capability...');

    await prisma.aiCapability.upsert({
      where: { slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG },
      update: { isSystem: false },
      create: {
        slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
        name: 'Detect Adaptive Scope Candidacy',
        description:
          'Cheap triage read over a freshly-uploaded questionnaire document: does its own text ' +
          'describe routing different respondents through different parts of it? Flags a ' +
          'candidate for the Routing Analyst; proposes no topics or rules itself.',
        category: 'app',
        executionType: 'internal',
        executionHandler: DETECT_SCOPE_CANDIDACY_HANDLER,
        functionDefinition:
          DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    logger.info(`✅ Seeded ${DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG} capability`);
  },
};

export default unit;
