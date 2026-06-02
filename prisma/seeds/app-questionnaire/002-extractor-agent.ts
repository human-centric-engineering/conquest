import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the extractor agent. NOTE: the extractor capability
 * (`AppExtractQuestionnaireStructureCapability`) builds its own structured
 * prompt via `buildExtractionPrompt` and does NOT read these instructions — they
 * exist so the agent is self-describing in the admin UI and so any future
 * chat-driven use of this agent has a sensible persona. The load-bearing
 * extraction rules live in `lib/app/questionnaire/ingestion/extraction-prompt.ts`.
 */
const EXTRACTOR_INSTRUCTIONS = `You are the questionnaire extractor for the ConQuest app. You convert an uploaded \
questionnaire document into a clean, structured form — sections, questions with \
inferred answer types, an inferred goal and audience — and you record every \
editorial decision (pruning boilerplate, fixing typos, rewriting prompts, merging \
duplicates, splitting compound questions, inferring goal/audience) as a revertible \
change record. You are opinionated but conservative: when unsure whether a span is \
content or boilerplate, keep it.`;

/**
 * Seed the questionnaire-extractor agent (F1.1 / PR3).
 *
 * The extractor capability is dispatched programmatically against this agent's
 * id; the agent carries the budget cap and the provider-agnostic binding. It
 * ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`. `visibility: 'internal'` keeps it out of the
 * public/embed surfaces.
 *
 * This is a ConQuest **app** agent, not a platform/system one: `isSystem: false`
 * so it lives under the admin "App" tab, is editable/deletable like any bespoke
 * agent, and is included in config backup/export (the platform's exporter skips
 * `isSystem` rows). The service account merely owns the seeded `createdBy`.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the
 * recursive runner; its `SeedHistory` key is the relative path
 * `app-questionnaire/002-extractor-agent`. Idempotent — the `update` branch only
 * re-asserts `isSystem: false` so re-seeding corrects any stray system flag
 * without clobbering an operator's other edits (model pin, budget change). Core
 * seeds (digit-prefixed) run before any app subdirectory, so `001-system-owner`'s
 * service account exists here.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/002-extractor-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire-extractor agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Extractor',
        slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        description:
          'Extracts an opinionated, structured questionnaire (sections, questions, goal, audience) plus a revertible editorial change log from an uploaded document. Dispatched by the ingestion API; not a chat agent.',
        systemInstructions: EXTRACTOR_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Extraction wants determinism, not creativity.
        temperature: 0.2,
        // Sections + questions + change log is a verbose structured payload;
        // reasoning models split this cap with internal reasoning (see
        // 010-model-auditor's headroom rationale).
        maxTokens: 16384,
        // A safety ceiling on extraction spend. The route adds a per-admin
        // sub-cap (PR4); this caps the shared agent's monthly total.
        monthlyBudgetUsd: 25,
        // The extractor grounds in the uploaded document, not any knowledge
        // base — restrict KB access so stray docs never leak into extraction.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent — surfaces under the
        // admin "App" tab and is included in config backup/export.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG} agent`);
  },
};

export default unit;
