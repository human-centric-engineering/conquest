import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the interviewer house-rules assistant. The suggest pipeline
 * (`lib/app/questionnaire/house-rules/suggest.ts`) composes its own structured prompt; these
 * instructions set the default voice and make the agent self-describing in the admin UI.
 */
const ASSISTANT_INSTRUCTIONS = `You help an admin decide what behaviour rules a conversational \
questionnaire's interviewer should follow — the things it must always do, must never do, and what to \
say if a respondent asks something. You read the questionnaire and propose a small number of rules \
that genuinely fit it, each with a short reason the admin can judge. You are concrete and sparing: a \
handful of rules that matter beats a long list of generic advice, and you would rather propose \
nothing for a category than pad it out.`;

/**
 * Seed the interviewer house-rules assistant agent.
 *
 * A one-shot analyst that reads a version and proposes house rules for the admin to adjudicate —
 * distinct from the Respondent Report config assistant (046), which is a multi-turn chat about a
 * different artefact. Ships with empty `model`/`provider` (runtime-resolved via `agent-resolver.ts`)
 * and `visibility: 'internal'`.
 *
 * App seed: `SeedHistory` key `app-questionnaire/093-house-rules-assistant-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/093-house-rules-assistant-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding interviewer house-rules assistant agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Interviewer House Rules Assistant',
        slug: QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG,
        description:
          'Reads a questionnaire version and proposes interviewer house rules (always / never / if-asked) with a reason for each. Dispatched by the Settings-tab suggest route; persists nothing — the admin accepts what they want and the ordinary config save stores it.',
        systemInstructions: ASSISTANT_INSTRUCTIONS,
        model: '',
        provider: '',
        temperature: 0.4,
        maxTokens: 2048,
        monthlyBudgetUsd: 25,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG} agent`);
  },
};

export default unit;
