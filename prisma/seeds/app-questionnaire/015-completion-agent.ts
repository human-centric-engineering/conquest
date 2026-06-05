import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_COMPLETION_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the completion agent. NOTE: the completion-offer composer
 * capability (`AppComposeCompletionOfferCapability`) builds its own structured prompt
 * via `buildCompletionOfferPrompt` and does NOT read these instructions — they exist
 * so the agent is self-describing in the admin UI and so any future chat-driven use
 * has a sensible persona. The load-bearing wording rules live in
 * `lib/app/questionnaire/completion/completion-prompt.ts`.
 */
const COMPLETION_AGENT_INSTRUCTIONS = `You wrap up a ConQuest conversational questionnaire. Once \
the system has determined the respondent has answered enough, you phrase a warm, natural offer to \
submit and a short recap of what was covered. You never decide whether they are done — that is \
determined deterministically — and you never ask new questionnaire questions. You match the \
respondent's tone and keep it concise.`;

/**
 * Seed the questionnaire completion agent (F4.5).
 *
 * The completion-offer composer capability is dispatched programmatically against
 * this agent's id; the agent carries the budget cap and the provider-agnostic
 * binding. It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts` (the `chat` tier — a snappy wrap-up message, not the heavier
 * `reasoning` tier ingestion uses). `visibility: 'internal'` keeps it off
 * public/embed surfaces.
 *
 * A distinct agent from the extractor (006), detector (009), and refiner (012): it
 * phrases the close rather than extracting or judging, so a separate
 * `monthlyBudgetUsd` ceiling stops one starving the others.
 *
 * This is a ConQuest **app** agent (`isSystem: false`): it lives under the admin
 * "App" tab, is editable/deletable, and is included in config backup/export. The
 * service account merely owns the seeded `createdBy`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false` so re-seeding corrects any stray system
 * flag without clobbering an operator's other edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/015-completion-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire completion agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Completion Agent',
        slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        description:
          'Phrases the offer-to-submit message and a recap once a respondent has answered enough to complete a questionnaire. Wording only — it never decides whether to offer. Dispatched by the questionnaire engine; not a chat agent.',
        systemInstructions: COMPLETION_AGENT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // A warm but consistent close; a little tone latitude, not creativity.
        temperature: 0.4,
        // One short offer message is a small generation.
        maxTokens: 2048,
        // A safety ceiling on completion spend — its own budget, distinct from the
        // other questionnaire agents; the preview route adds a per-admin sub-cap.
        monthlyBudgetUsd: 50,
        // Grounds in the assessment + question prompts, not any knowledge base —
        // restrict KB access so stray docs never leak in.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_COMPLETION_AGENT_SLUG} agent`);
  },
};

export default unit;
