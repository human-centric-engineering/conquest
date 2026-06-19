import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { RESPONDENT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Respondent Report agent. The generation pipeline
 * (`lib/app/questionnaire/report/generate.ts`) composes its own structured prompt and layers the
 * admin's per-version instructions on top; these instructions set the agent's default voice and make
 * it self-describing in the admin UI.
 */
const REPORT_INSTRUCTIONS = `You are the Respondent Report writer for the ConQuest app. After a \
respondent completes a questionnaire you write them a clear, personalised report grounded strictly in \
their own answers — never invented facts. You address the respondent directly, keep the tone warm and \
constructive, and always finish with concrete, actionable next steps they can take. When reference \
material from a knowledge base is supplied you use it to substantiate and sharpen the insights.`;

/**
 * Seed the Respondent Report agent (report kind `respondent`).
 *
 * Carries the provider-agnostic binding + budget cap for mode-2 insights generation; loaded by slug
 * from the generation pipeline. Ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`. `visibility: 'internal'` keeps it off public/embed picker surfaces. A distinct
 * agent from the composer/extractor — report writing carries its own budget and persona.
 *
 * App seed: `SeedHistory` key `app-questionnaire/045-respondent-report-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false` so re-seeding corrects a stray system flag
 * without clobbering an operator's edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/045-respondent-report-agent',
  async run({ prisma, logger }) {
    logger.info('📝 Seeding respondent-report agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: RESPONDENT_REPORT_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Respondent Report Writer',
        slug: RESPONDENT_REPORT_AGENT_SLUG,
        description:
          'Writes the per-respondent insights report after a questionnaire is completed, grounded in the captured answers and (optionally) the client knowledge base. Dispatched by the report generation pipeline; not a chat agent.',
        systemInstructions: REPORT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Coherent, lightly opinionated prose.
        temperature: 0.4,
        // A multi-section narrative; reasoning models split this cap with internal reasoning.
        maxTokens: 8192,
        // A safety ceiling on report-generation spend (shared agent monthly total).
        monthlyBudgetUsd: 25,
        // It reads the client KB by an explicit documentIds allowlist (per-client tag scope), not the
        // agent restricted-access resolver — restricted keeps it off the global corpus by default.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${RESPONDENT_REPORT_AGENT_SLUG} agent`);
  },
};

export default unit;
