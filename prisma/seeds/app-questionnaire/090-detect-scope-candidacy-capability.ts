import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION,
  DETECT_SCOPE_CANDIDACY_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the Conditional Topics candidacy-check `AiCapability` row (P17.19).
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
/** The pre-rename slug this unit used to own. See the rename step in `run`. */
const LEGACY_CAPABILITY_SLUG = 'app_detect_adaptive_scope_candidacy';

const unit: SeedUnit = {
  name: 'app-questionnaire/090-detect-scope-candidacy-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding Conditional Topics candidacy-check capability...');

    // The slug carries the feature's name, and the feature was renamed (Adaptive Scope → Conditional
    // Topics). Rename the row this unit already owns BEFORE upserting, or the upsert would create a
    // second row on every database seeded before the rename and leave the original stranded — the
    // operator's edits to `name` / `description` / `isActive` with it. Renaming in place means the
    // upsert below finds the same row it has always maintained. Idempotent: a database that has
    // never seen the old slug, or that already carries the new one, skips this entirely.
    const legacy = await prisma.aiCapability.findUnique({
      where: { slug: LEGACY_CAPABILITY_SLUG },
      select: { id: true },
    });
    if (legacy) {
      const current = await prisma.aiCapability.findUnique({
        where: { slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG },
        select: { id: true },
      });
      if (current) {
        // Both exist — this unit already ran post-rename and created the new row. `097` deactivates
        // the stranded one; nothing here should touch it.
        logger.warn(`   ${LEGACY_CAPABILITY_SLUG} is superseded and stranded — see seed 097`);
      } else {
        await prisma.aiCapability.update({
          where: { id: legacy.id },
          data: { slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG },
        });
        logger.info(
          `   Renamed ${LEGACY_CAPABILITY_SLUG} → ${DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG}`
        );
      }
    }

    await prisma.aiCapability.upsert({
      where: { slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG },
      update: {
        // Code-owned fields are re-applied so an edited definition reaches rows
        // that already exist; `name` / `description` / `category` / `isActive`
        // stay operator-owned. See `.context/database/seeding.md` (#545).
        isSystem: false,
        executionType: 'internal',
        executionHandler: DETECT_SCOPE_CANDIDACY_HANDLER,
        functionDefinition:
          DETECT_SCOPE_CANDIDACY_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
      },
      create: {
        slug: DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
        name: 'Detect Conditional Topics Candidacy',
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
