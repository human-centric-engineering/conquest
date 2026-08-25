import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { SCOPE_PLANNER_AGENT_SLUG } from '@/lib/app/questionnaire/scope/constants';

/**
 * System-prompt context for the Scope Planner.
 *
 * NOTE: the planner builds its own structured prompt in `lib/app/questionnaire/scope/planner.ts`
 * and does NOT read these instructions at runtime — they exist so the agent is self-describing in
 * the admin UI and the prompt library. The load-bearing rules live in that module.
 */
const PLANNER_INSTRUCTIONS = `You decide which parts of a questionnaire are worth a respondent's \
time. Given what they said in an opening interview, and a set of candidate topics each carrying the \
author's own account of when it is the right one to ask about, you select the few that genuinely fit \
what this person conveyed.

You read for what a respondent MEANS rather than the words they used — a topic can be a clear match \
when someone has described the situation it covers without using any of its words. You treat \
choosing fewer topics as a good answer rather than a failure, because asking about an area nothing \
pointed at wastes their time and produces a score they did not need. You weigh the author's criteria \
above your own general judgement, you report your confidence honestly rather than inflating it, and \
you never invent a topic that was not offered to you.`;

/**
 * Seed the Conditional Topics planner agent (P17).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` — the
 * planner asks for the `reasoning` tier, since weighing free-text answers against several topics'
 * criteria is a judgement task.
 *
 * The important operational note: **a respondent is waiting on this call**, mid-conversation, having
 * just finished the opening. It runs with a 12-second timeout and deterministic guardrails, so a
 * slow or unavailable model degrades to the author's fallback topic set rather than leaving someone
 * staring at a spinner. That is why `maxTokens` is small — the output is one decision object.
 *
 * App seed: `SeedHistory` key `app-questionnaire/086-scope-planner-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false` so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/086-scope-planner-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding Conditional Topics planner agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: SCOPE_PLANNER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Scope Planner',
        slug: SCOPE_PLANNER_AGENT_SLUG,
        description:
          'Decides which conditional topics a respondent’s interview should cover, from what they ' +
          'said in the opening and the author’s "choose when" criteria. Dispatched once per ' +
          'session when the opening completes; not a chat agent.',
        systemInstructions: PLANNER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Near-deterministic: the same opening against the same criteria should plan the same way
        // twice. Selecting topics is a judgement, but it is not a creative one.
        temperature: 0.2,
        // One small decision object. Reasoning models split this cap with internal reasoning, so
        // it is not as tight as it looks.
        maxTokens: 2048,
        // Safety ceiling on planning spend across all questionnaires.
        monthlyBudgetUsd: 15,
        // Reasons over the supplied opening and candidates, never a knowledge base.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${SCOPE_PLANNER_AGENT_SLUG} agent`);
  },
};

export default unit;
