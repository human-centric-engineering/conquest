import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the conversational interviewer agent. This is the persona the
 * original plan specified (`Conversational Questionnaire Phases.md` §Phase 6) — "Ask the
 * current targeted question naturally — never as a numbered form field." The load-bearing
 * per-turn instructions are assembled by `buildStreamingQuestionPrompt`
 * (`question-stream.ts`); this string makes the agent self-describing in the admin UI and
 * gives any future chat-driven use a sensible default voice.
 */
const INTERVIEWER_AGENT_INSTRUCTIONS = `You are a warm, conversational interviewer helping \
someone complete a questionnaire. You ask the one question you are given naturally — never as a \
numbered form field — briefly acknowledging what the respondent just said before you move on. \
You calibrate tone and depth to the audience: plain language for novices, domain terms for \
experts; when the topic is sensitive you slow down and acknowledge difficulty. You never invent \
new questions, never answer on the respondent's behalf, and never restate the whole survey — you \
ask exactly the current question, conversationally. Keep it to a sentence or two and match the \
respondent's tone and language.`;

/**
 * Seed the conversational interviewer agent (question-phrasing).
 *
 * The live `/messages` route dispatches this agent's binding via `streamQuestionMessage` to
 * render each asked question as natural prose (the question analogue of the F4.5 completion
 * agent, seed 015). It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts` (the snappy `chat` tier — short conversational turns, not the heavier
 * `reasoning` tier ingestion uses). `visibility: 'internal'` keeps it off public/embed
 * surfaces. A distinct agent (and budget) from the extractor/detector/refiner/completion
 * agents so one can't starve the others.
 *
 * This is a ConQuest **app** agent (`isSystem: false`): editable/deletable under the admin
 * "App" tab and included in config backup/export. Idempotent — the `update` branch only
 * re-asserts `isSystem: false` so re-seeding corrects a stray system flag without clobbering
 * an operator's edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/026-interviewer-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire interviewer agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Interviewer Agent',
        slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        description:
          'Phrases each asked questionnaire question as warm, conversational prose — acknowledging the prior answer and calibrating tone to the audience — instead of surfacing the raw prompt verbatim. Wording only; the engine decides which question to ask. Dispatched by the live turn loop; not a chat agent.',
        systemInstructions: INTERVIEWER_AGENT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (chat tier).
        model: '',
        provider: '',
        // Conversational warmth with a little latitude, but it must stay faithful to the
        // underlying question — not a creative rewrite.
        temperature: 0.5,
        // One or two sentences per asked question.
        maxTokens: 512,
        // A safety ceiling on phrasing spend — its own budget, distinct from the other
        // questionnaire agents (one extra call per asked question can add up over a session).
        monthlyBudgetUsd: 100,
        // Grounds in the question + recent transcript, not any knowledge base — restrict KB
        // access so stray docs never leak into the asked question.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG} agent`);
  },
};

export default unit;
