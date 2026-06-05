import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the contradiction-detector agent. NOTE: the
 * contradiction-detector capability (`AppDetectContradictionsCapability`) builds its
 * own structured prompt via `buildContradictionDetectionPrompt` and does NOT read
 * these instructions — they exist so the agent is self-describing in the admin UI
 * and so any future chat-driven use has a sensible persona. The load-bearing
 * detection rules live in `lib/app/questionnaire/contradiction/detection-prompt.ts`.
 */
const CONTRADICTION_DETECTOR_INSTRUCTIONS = `You are the contradiction detector for the ConQuest \
conversational questionnaire. Given a respondent's captured answers across the questionnaire, you \
identify GENUINE logical contradictions — answers that cannot all be true — and report which \
questions conflict, why, and how serious the conflict is. You surface contradictions for the agent \
to confirm with the respondent; you never overwrite an answer. You do not invent conflicts: if the \
answers are consistent, you report none.`;

/**
 * Seed the questionnaire contradiction-detector agent (F4.3).
 *
 * The contradiction-detector capability is dispatched programmatically against this
 * agent's id; the agent carries the budget cap and the provider-agnostic binding.
 * It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts` (the `chat` tier — per-turn-ish detection, not the heavier
 * `reasoning` tier ingestion uses). `visibility: 'internal'` keeps it off
 * public/embed surfaces.
 *
 * A distinct agent from the answer extractor (006): detection runs on its own
 * cadence (per turn and/or at the completion sweep) with its own persona, so a
 * separate `monthlyBudgetUsd` ceiling stops one starving the other.
 *
 * This is a ConQuest **app** agent (`isSystem: false`): it lives under the admin
 * "App" tab, is editable/deletable, and is included in config backup/export. The
 * service account merely owns the seeded `createdBy`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false` so re-seeding corrects any stray system
 * flag without clobbering an operator's other edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/009-contradiction-detector-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire contradiction-detector agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Contradiction Detector',
        slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        description:
          "Compares a respondent's captured answers across slots and surfaces genuine logical contradictions for confirmation, each with a severity and (under probe mode) a follow-up question. Dispatched by the questionnaire engine; not a chat agent.",
        systemInstructions: CONTRADICTION_DETECTOR_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Detection wants consistency, not creativity.
        temperature: 0.2,
        // A handful of slots + values is a small structured payload.
        maxTokens: 4096,
        // A safety ceiling on detection spend — its own budget, distinct from the
        // answer extractor (006); the preview route adds a per-admin sub-cap on top.
        monthlyBudgetUsd: 50,
        // Detection grounds in the answers + questionnaire structure, not any
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

    logger.info(`✅ Seeded ${QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG} agent`);
  },
};

export default unit;
