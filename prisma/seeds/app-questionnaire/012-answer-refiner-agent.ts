import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the answer-refiner agent. NOTE: the answer-refiner
 * capability (`AppRefineAnswerCapability`) builds its own structured prompt via
 * `buildRefinementPrompt` and does NOT read these instructions — they exist so the
 * agent is self-describing in the admin UI and so any future chat-driven use has a
 * sensible persona. The load-bearing refinement rules live in
 * `lib/app/questionnaire/refinement/refinement-prompt.ts`.
 */
const ANSWER_REFINER_INSTRUCTIONS = `You are the answer refiner for the ConQuest conversational \
questionnaire. Given a respondent's already-captured answers and new context (a clarifying message \
and/or a flagged contradiction), you decide for each answer whether to REFINE it (the value genuinely \
evolved in light of later context), OVERWRITE it (the earlier value was a plain mistake), or LEAVE it \
unchanged. You preserve a refinement history and never change an answer the new context doesn't \
warrant. You do not "improve" answers that are already correct.`;

/**
 * Seed the questionnaire answer-refiner agent (F4.4).
 *
 * The answer-refiner capability is dispatched programmatically against this agent's
 * id; the agent carries the budget cap and the provider-agnostic binding. It ships
 * with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts`
 * (the `chat` tier — per-turn-ish refinement, not the heavier `reasoning` tier).
 * `visibility: 'internal'` keeps it off public/embed surfaces.
 *
 * A distinct agent from the answer extractor (006) and contradiction detector (009):
 * refinement runs on its own cadence (when a contradiction is reconciled or a
 * respondent clarifies an earlier answer) with its own persona, so a separate
 * `monthlyBudgetUsd` ceiling stops one starving the others.
 *
 * This is a ConQuest **app** agent (`isSystem: false`): editable/deletable, under the
 * admin "App" tab, included in config backup/export. Idempotent — the `update` branch
 * only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/012-answer-refiner-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire answer-refiner agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Answer Refiner',
        slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
        description:
          "Decides whether a respondent's already-captured answers should be updated in light of new context — refine (the value evolved), overwrite (a mistaken capture), or leave — preserving a refinement history. Dispatched by the questionnaire engine; not a chat agent.",
        systemInstructions: ANSWER_REFINER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Refinement wants consistency, not creativity.
        temperature: 0.2,
        // A handful of slots + values is a small structured payload.
        maxTokens: 4096,
        // A safety ceiling on refinement spend — its own budget, distinct from the
        // extractor (006) and detector (009); the route adds a per-admin sub-cap.
        monthlyBudgetUsd: 50,
        // Refinement grounds in the answers + questionnaire structure, not any
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

    logger.info(`✅ Seeded ${QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG} agent`);
  },
};

export default unit;
