import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_SELECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System prompt for the adaptive-selection agent. The load-bearing per-call
 * instructions (the numbered candidate list + the strict output contract) are
 * assembled at run time by `_lib/adaptive-deps.ts`; these instructions set the
 * persona and pin the JSON shape so the agent is self-describing in the admin UI.
 */
const SELECTOR_INSTRUCTIONS = `You choose which question a conversational questionnaire should ask next. \
Given the respondent's recent messages and a short numbered list of candidate questions, \
pick the ONE that follows most naturally from what they just said — the question that keeps \
the conversation coherent rather than jumping topics. Prefer continuity and relevance over \
list order. Reply with ONLY a JSON object: {"choice": <1-based number of the chosen \
candidate, or 0 if none fits>, "rationale": "<one short sentence>"}. No prose outside the JSON.`;

/**
 * Seed the questionnaire adaptive-selection agent (F4.1).
 *
 * Driven via `drainStreamChat` (the same path the evaluation judges use): the
 * adaptive strategy hands it the recent transcript + similarity-ranked candidates
 * and parses its `{ choice, rationale }` JSON. Ships with empty `model`/`provider`
 * so it resolves dynamically via `agent-resolver.ts`. `visibility: 'internal'`
 * keeps it off public/embed pickers; `isSystem: false` marks it a ConQuest **app**
 * agent (admin "App" tab, editable, included in config backup/export).
 *
 * App seed: `SeedHistory` key `app-questionnaire/005-selection-agent`. Idempotent —
 * the `update` branch only re-asserts `isSystem: false` so re-seeding corrects a
 * stray system flag without clobbering an operator's model pin / budget edit.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/005-selection-agent',
  async run({ prisma, logger }) {
    logger.info('🧭 Seeding questionnaire adaptive-selection agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Questionnaire Selector',
        slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        description:
          'Picks the next question for the adaptive selection strategy: given the recent ' +
          'transcript and similarity-ranked candidates, chooses the one that flows most ' +
          'naturally. Dispatched per turn by the selection engine; not a chat agent.',
        systemInstructions: SELECTOR_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // A small, deterministic decision — keep it tight.
        temperature: 0.2,
        // The reply is a tiny JSON object; cap low.
        maxTokens: 256,
        // A safety ceiling on selection spend across all sessions sharing the agent.
        monthlyBudgetUsd: 25,
        // Grounds in the supplied candidates, not any knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_SELECTOR_AGENT_SLUG} agent`);
  },
};

export default unit;
