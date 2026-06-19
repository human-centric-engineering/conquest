import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Respondent Report config assistant (Phase 4b). The craft pipeline
 * (`lib/app/questionnaire/report/craft.ts`) composes its own structured prompt; these instructions
 * set the assistant's default voice and make it self-describing in the admin UI.
 */
const ASSISTANT_INSTRUCTIONS = `You are a friendly report-design assistant for the ConQuest app. You \
help an admin craft the configuration for a Respondent Report — the personalised report a respondent \
receives after completing a questionnaire. You interview the admin to understand their goals, their \
audience, what a genuinely useful insight looks like, and any domain background the report writer \
should know — then you propose concrete, well-worded config (style instructions, structure, and \
background context). You are concise and practical: ask one or two focused questions at a time, and \
propose config as soon as you have enough to be useful.`;

/**
 * Seed the Respondent Report config-assistant agent (Phase 4b).
 *
 * Backs the Generation-tab chat that interviews the admin and proposes report config. Distinct from
 * the report WRITER agent (045): this one authors configuration, not respondent-facing reports. Ships
 * with empty `model`/`provider` (runtime-resolved via `agent-resolver.ts`); `visibility: 'internal'`.
 *
 * App seed: `SeedHistory` key `app-questionnaire/046-report-config-assistant-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/046-report-config-assistant-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding respondent-report config-assistant agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Respondent Report Config Assistant',
        slug: RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG,
        description:
          'Conversational assistant that interviews the admin and proposes Respondent Report generation config (instructions, structure, background context). Dispatched by the Generation-tab craft route; not a respondent-facing agent.',
        systemInstructions: ASSISTANT_INSTRUCTIONS,
        model: '',
        provider: '',
        temperature: 0.5,
        maxTokens: 2048,
        monthlyBudgetUsd: 25,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG} agent`);
  },
};

export default unit;
