import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the interviewer opening-questions assistant. The suggest pipeline
 * (`lib/app/questionnaire/opening-examples/suggest.ts`) composes its own structured prompt; these
 * instructions set the default voice and make the agent self-describing in the admin UI.
 */
const ASSISTANT_INSTRUCTIONS = `You help an admin decide how a conversational questionnaire should \
open — the very first question the interviewer asks, before any specific question comes up. You read \
the questionnaire's subject, audience and coverage, and propose a few example openers that are broad \
enough for someone to talk freely at and unmistakably about this questionnaire rather than any other. \
Each comes with a short reason the admin can judge. You know your examples are used as guidance the \
interviewer riffs on rather than a script it reads out, so you write strong models of a register, and \
you vary them so the admin has a real choice rather than one question rephrased.`;

/**
 * Seed the interviewer opening-questions assistant agent.
 *
 * The sibling of the house-rules assistant (093) and the same shape: a one-shot analyst that reads a
 * version and proposes candidates for the admin to adjudicate, persisting nothing itself. Ships with
 * empty `model`/`provider` (runtime-resolved via `agent-resolver.ts`) and `visibility: 'internal'`.
 *
 * `maxTokens` is half the house-rules assistant's: a handful of one-sentence questions plus a
 * one-line reason each is a much smaller answer than up to eight rules with triggers.
 *
 * App seed: `SeedHistory` key `app-questionnaire/094-opening-examples-assistant-agent`. Idempotent —
 * the `update` branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/094-opening-examples-assistant-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding interviewer opening-questions assistant agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Interviewer Opening Questions Assistant',
        slug: QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG,
        description:
          'Reads a questionnaire version and proposes example opening questions with a reason for each. Dispatched by the Settings-tab suggest route; persists nothing — the admin accepts what they want and the ordinary config save stores it. The interviewer is guided by the accepted examples, never made to read them out.',
        systemInstructions: ASSISTANT_INSTRUCTIONS,
        model: '',
        provider: '',
        // Warmer than the house-rules assistant's 0.4: the job here is a genuine variety of
        // registers, and a low temperature returns five rephrasings of the same question.
        temperature: 0.7,
        maxTokens: 1024,
        monthlyBudgetUsd: 25,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG} agent`);
  },
};

export default unit;
