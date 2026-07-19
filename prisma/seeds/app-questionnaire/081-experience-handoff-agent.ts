import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { EXPERIENCE_HANDOFF_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

/**
 * System-prompt context for the handoff briefing agent.
 *
 * NOTE: the runtime prompt is built in
 * `lib/app/questionnaire/experiences/carryover/build.ts`; these instructions exist so the agent is
 * self-describing in the admin UI and the prompt library.
 */
const HANDOFF_INSTRUCTIONS = `A respondent has just finished one part of a multi-part conversation \
and is about to begin the next. You write two things: the briefing the next interviewer needs, and \
the single sentence that opens the next part.

The briefing is for the interviewer, not the respondent — what this person's situation is and what \
matters to them, so the next questions land well. You carry only what the respondent actually said: \
you never infer a fact they did not state, and you never soften a difficulty they described.

The opening line is spoken to the respondent. It is warm, it is one sentence, it shows you were \
listening by referencing something specific they raised, and it leads naturally into the next topic. \
It never mentions that a decision was made about them.`;

/**
 * Seed the Experience handoff briefing agent (P15.2).
 *
 * Compresses the carry-over into a short briefing plus the bridging line that becomes the next
 * leg's first assistant turn. **Optional by design**: when this agent is missing, unavailable, or
 * fails, the next leg still receives the deterministic data-slot digest — the journey continues,
 * it just reads a little flatter at the seam.
 *
 * Like the router, it runs while the respondent waits, so it is bounded the same way (12s timeout,
 * silent fallback).
 *
 * App seed: `SeedHistory` key `app-questionnaire/081-experience-handoff-agent`. Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/081-experience-handoff-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding Experience handoff briefing agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: EXPERIENCE_HANDOFF_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Experience Handoff Briefing',
        slug: EXPERIENCE_HANDOFF_AGENT_SLUG,
        description:
          'Compresses what a respondent conveyed in one part of a journey into a briefing for the ' +
          'next interviewer, plus the warm opening line that bridges the two. Dispatched at the ' +
          'handoff; optional — the journey continues without it.',
        systemInstructions: HANDOFF_INSTRUCTIONS,
        model: '',
        provider: '',
        // Warmer than the router: the opening line is respondent-facing prose and should not read
        // as a template. Still restrained — this is a bridge, not an essay.
        temperature: 0.5,
        maxTokens: 2048,
        monthlyBudgetUsd: 15,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${EXPERIENCE_HANDOFF_AGENT_SLUG} agent`);
  },
};

export default unit;
