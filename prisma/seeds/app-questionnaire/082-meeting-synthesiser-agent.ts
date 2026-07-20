import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { MEETING_SYNTHESIS_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

/**
 * System-prompt context for the breakout synthesiser.
 *
 * NOTE: the synthesiser builds its own structured prompt in
 * `lib/app/questionnaire/experiences/meeting/synthesise.ts` and does NOT read these instructions at
 * runtime — they exist so the agent is self-describing in the admin UI and the prompt library. The
 * load-bearing rules, including the anonymity constraints, live in that module.
 */
const SYNTHESISER_INSTRUCTIONS = `A group has just answered the same short questionnaire \
individually during a breakout. You read what they collectively said — their data-slot positions, \
the reasoning behind them, and any position that changed during the conversation — and write the \
handful of findings a facilitator will read out to the room.

You are writing for someone standing at the front of a room, about to speak: findings are \
sentences that can be said aloud, ordered the way they would be said, and chosen for what the room \
can usefully discuss.

You never name or number a participant and never quote anyone verbatim. You count the support \
behind each finding honestly, because that number decides whether it is safe to say aloud at all. \
You would rather return nothing than manufacture a pattern that is not there.`;

/**
 * Seed the breakout synthesiser agent (P15.5).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` — the
 * caller asks for the `reasoning` tier, since clustering positions across a room and weighing
 * agreement against dissent is a judgement task.
 *
 * The operational note that distinguishes this from the routing selector: **nobody is waiting on a
 * spinner.** The facilitator triggers a synthesis and keeps talking to the room, so this agent gets
 * a 60-second timeout and a far larger token budget than the selector's. Correctness beats latency
 * here, which is the reverse of the fork a respondent waits at.
 *
 * `temperature` is low but not near-zero: the task involves phrasing findings for speech, which
 * benefits from a little freedom, while the counts and the anonymity rules are enforced in code
 * rather than trusted to the model.
 *
 * App seed: `SeedHistory` key `app-questionnaire/082-meeting-synthesiser-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false` so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/082-meeting-synthesiser-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding meeting breakout synthesiser agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: MEETING_SYNTHESIS_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Meeting Breakout Synthesiser',
        slug: MEETING_SYNTHESIS_AGENT_SLUG,
        description:
          'Turns a breakout’s data-slot answers into a short list of findings — agreements, ' +
          'tensions, outliers, themes and open questions — for a facilitator to read out to the ' +
          'room. Reads positions and their reasoning, never raw conversation. Dispatched when a ' +
          'breakout is synthesised; not a chat agent.',
        systemInstructions: SYNTHESISER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Low, but not near-deterministic: findings are phrased for speech, which benefits from a
        // little freedom. The counts and anonymity rules are enforced in code, not trusted here.
        temperature: 0.3,
        // Generous — a breakout of twenty people across several data slots is a lot of material,
        // and reasoning models split this cap with their internal reasoning.
        maxTokens: 4096,
        // Safety ceiling on synthesis spend across all meetings.
        monthlyBudgetUsd: 25,
        // Reasons over the supplied material only, never a knowledge base.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${MEETING_SYNTHESIS_AGENT_SLUG} agent`);
  },
};

export default unit;
