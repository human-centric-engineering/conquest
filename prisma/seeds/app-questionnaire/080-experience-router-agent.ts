import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { EXPERIENCE_ROUTER_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

/**
 * System-prompt context for the routing selector.
 *
 * NOTE: the selector builds its own structured prompt in
 * `lib/app/questionnaire/experiences/routing/select.ts` and does NOT read these instructions at
 * runtime — they exist so the agent is self-describing in the admin UI and the prompt library. The
 * load-bearing rules live in that module.
 */
const ROUTER_INSTRUCTIONS = `You decide what a respondent should do next in a multi-part \
questionnaire journey. Given a digest of what they conveyed in the part they just finished, and a \
set of candidate follow-up questionnaires each with the author's own account of when it is the \
right choice, you either select ONE follow-up or decide the journey should conclude with a summary.

You weigh the author's "choose when" criteria above your own general judgement, you report your \
confidence honestly rather than inflating it, and you treat concluding as a good outcome rather \
than a failure. You never invent a candidate that was not offered to you.`;

/**
 * Seed the Experience routing selector agent (P15.2).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` — the
 * route asks for the `reasoning` tier, since weighing a digest against several candidates' criteria
 * is a judgement task.
 *
 * The important operational note: **a respondent is waiting on this call.** The selector runs with
 * a 12-second timeout and a deterministic fallback, so a slow or unavailable model degrades to
 * "conclude with a report" rather than leaving someone staring at a spinner. That is why
 * `maxTokens` is small — the output is one decision object, not prose.
 *
 * App seed: `SeedHistory` key `app-questionnaire/080-experience-router-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false` so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/080-experience-router-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding Experience routing selector agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: EXPERIENCE_ROUTER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Experience Router',
        slug: EXPERIENCE_ROUTER_AGENT_SLUG,
        description:
          'Decides whether a multi-part questionnaire journey should conclude with a report or ' +
          'continue into a specific follow-up, chosen from the experience’s candidate steps based ' +
          'on what the respondent conveyed. Dispatched at the handoff; not a chat agent.',
        systemInstructions: ROUTER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Near-deterministic: the same digest against the same criteria should route the same way
        // twice. Routing is a judgement, but it is not a creative one.
        temperature: 0.2,
        // One small decision object. Reasoning models split this cap with internal reasoning, so
        // it is not as tight as it looks.
        maxTokens: 2048,
        // Safety ceiling on routing spend across all experiences.
        monthlyBudgetUsd: 15,
        // Reasons over the supplied digest and candidates, never a knowledge base.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${EXPERIENCE_ROUTER_AGENT_SLUG} agent`);
  },
};

export default unit;
