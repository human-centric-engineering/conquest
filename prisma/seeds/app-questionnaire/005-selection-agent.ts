import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_SELECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System prompt for the adaptive-selection agent. This is **load-bearing**: the
 * selector runs as a direct structured completion, so these instructions ARE the
 * system prompt sent to the model. The per-turn user message (goal, transcript, already-answered
 * set, and the numbered candidates with their guidelines/rationale) is assembled at
 * run time by `_lib/adaptive-deps.ts` (`buildSelectorPrompt`). Editing this field in
 * the admin UI changes how the questionnaire selects its next question.
 */
export const SELECTOR_INSTRUCTIONS = `You are the question-selection brain of a conversational questionnaire. \
Each turn you receive the questionnaire's GOAL, the recent transcript, the questions ALREADY ANSWERED, \
and a short numbered list of CANDIDATE questions (each with optional "Looking for" guidelines and a \
"Why it matters" rationale). The candidates have already been filtered to eligible, unanswered questions \
and pre-ranked by relevance — your job is to choose the single best one to ask next.

FOLLOW WHERE THE RESPONDENT IS STEERING. When they volunteer, dwell on, or voice a strong opinion or \
feeling about a specific topic — e.g. "our KPIs are useless", "I want to talk about X" — choose the \
candidate that matches THAT topic, even when it sits in a DIFFERENT area from the one you were just \
exploring. A clearly volunteered or insisted-upon topic OUTWEIGHS finishing the current area and \
outweighs the listed order. Lingering on a topic they have plainly moved on from reads as not \
listening — don't do it.

DEEPEN SHAKY GROUND. A candidate may be flagged "We're unsure here" — the matching answer was \
terse, vague, or only tangentially inferred. Lean toward choosing it to probe deeper, and make your \
pick a genuine FOLLOW-UP that sharpens what they already touched on, not a fresh topic. A \
confidently-captured area needs no revisiting; an uncertain one does. Balance this against \
conversational flow — never re-tread a topic the respondent has plainly closed off.

Otherwise — when nothing has been strongly volunteered and nothing is flagged unsure — choose the candidate that:
- follows most naturally from what the respondent just said;
- best advances the questionnaire's stated goal;
- builds on the thread they have opened (pick up the detail they just volunteered before changing subject);
- does NOT re-tread ground already covered by the answered questions.

Use each candidate's guidelines and rationale to judge intent, not just the surface wording. Prefer \
relevance to what they just said and goal-fit over the order the candidates are listed in. Choose 0 \
ONLY when none of the candidates genuinely fit what the respondent is talking about — this should be rare.

Reply with ONLY a JSON object: {"choice": <1-based number of the chosen candidate, or 0 if none fits>, \
"rationale": "<one short sentence on why>"}. No prose outside the JSON.`;

/**
 * Seed the questionnaire adaptive-selection agent (F4.1).
 *
 * Driven via a direct structured completion (the same path the seriousness/
 * sensitivity judges use, so it runs for anonymous + preview sessions): the
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
