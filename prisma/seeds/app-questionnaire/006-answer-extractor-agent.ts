import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the answer-extractor agent. NOTE: the answer-extractor
 * capability (`AppExtractAnswerSlotsCapability`) builds its own structured prompt
 * via `buildAnswerExtractionPrompt` and does NOT read these instructions — they
 * exist so the agent is self-describing in the admin UI and so any future
 * chat-driven use has a sensible persona. The load-bearing extraction rules live
 * in `lib/app/questionnaire/extraction/extraction-prompt.ts`.
 */
const ANSWER_EXTRACTOR_INSTRUCTIONS = `You are the answer extractor for the ConQuest conversational \
questionnaire. Given a respondent's message and the question being asked, you identify the typed \
answer values it provides — for the active question and for any other questions the same message \
happens to answer. You record each with a confidence, a provenance (whether it was stated outright, \
inferred, or synthesised across the conversation), and a short rationale. You score confidence by how \
PLAINLY a position is expressed, not how often: a clearly-stated answer is high-confidence the first \
time you hear it, even when briefly or bluntly put, and you never downgrade a stated position just \
because it maps onto a scale. You reserve low confidence for genuinely weak, inferred signal, and only \
rise toward certainty as later turns corroborate a position. You never invent an answer the message \
does not support: if it answers nothing, you extract nothing.`;

/**
 * Seed the questionnaire answer-extractor agent (F4.2).
 *
 * The answer-extractor capability is dispatched programmatically against this
 * agent's id; the agent carries the budget cap and the provider-agnostic binding.
 * It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts` (the `chat` tier — per-turn extraction, not the heavier
 * `reasoning` tier ingestion uses). `visibility: 'internal'` keeps it off
 * public/embed surfaces.
 *
 * A distinct agent from the document-structure extractor (002): answer extraction
 * runs once per respondent turn — far higher volume than one-off ingestion — so a
 * separate `monthlyBudgetUsd` ceiling stops one starving the other.
 *
 * This is a ConQuest **app** agent (`isSystem: false`): it lives under the admin
 * "App" tab, is editable/deletable, and is included in config backup/export. The
 * service account merely owns the seeded `createdBy`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false` so re-seeding corrects any stray
 * system flag without clobbering an operator's other edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/006-answer-extractor-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire answer-extractor agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Answer Extractor',
        slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        description:
          "Extracts typed answer values from a respondent's message for the active question and any side-effect answers, each with confidence and provenance. Dispatched per turn by the questionnaire engine; not a chat agent.",
        systemInstructions: ANSWER_EXTRACTOR_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Extraction wants determinism, not creativity.
        temperature: 0.2,
        // One message answering a few slots is a small structured payload.
        maxTokens: 4096,
        // A safety ceiling on per-turn extraction spend. Higher than the one-off
        // ingestion extractor (002) because this runs every respondent turn; the
        // preview route adds a per-admin sub-cap on top (PR3).
        monthlyBudgetUsd: 50,
        // Extraction grounds in the message + questionnaire structure, not any
        // knowledge base — restrict KB access so stray docs never leak in.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG} agent`);
  },
};

export default unit;
