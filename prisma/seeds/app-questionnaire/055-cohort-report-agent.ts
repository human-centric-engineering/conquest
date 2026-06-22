import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { COHORT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Cohort Report agent (report kind `cohort`). The generation pipeline
 * (`lib/app/questionnaire/cohort-report/generate.ts`) composes its own structured prompt and layers
 * the admin's per-version generation config (length / detail / formality / instructions / structure)
 * on top; these instructions set the agent's default analytical voice and make it self-describing in
 * the admin UI.
 */
const COHORT_REPORT_INSTRUCTIONS = `You are the Cohort Report analyst for the ConQuest app. Given the \
aggregated results of a questionnaire answered by a whole cohort, you produce a cross-respondent \
report: a thematic analysis that surfaces the most significant patterns, the notable differences \
between demographic segments, and anything surprising — always judged against the report's goals. You \
weave data and analysis into clear prose, propose charts that illustrate the key findings, and finish \
with concrete recommendations and actions. You ground every claim in the supplied results, never \
invent numbers, and never reveal a figure that has been withheld to protect respondent privacy.`;

/**
 * Seed the Cohort Report agent (report kind `cohort`). The cross-respondent sibling of the
 * Respondent Report agent (seed 045). Carries the provider-agnostic binding + budget cap for report
 * generation; loaded by slug from the generation pipeline. Empty `model`/`provider` resolve
 * dynamically via `agent-resolver.ts`. `knowledgeAccessMode: 'restricted'` (reads the client KB by an
 * explicit documentIds allowlist, not the global corpus); `visibility: 'internal'` keeps it off
 * public/embed picker surfaces.
 *
 * App seed: `SeedHistory` key `app-questionnaire/055-cohort-report-agent`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/055-cohort-report-agent',
  async run({ prisma, logger }) {
    logger.info('📊 Seeding cohort-report agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: COHORT_REPORT_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Cohort Report Analyst',
        slug: COHORT_REPORT_AGENT_SLUG,
        description:
          'Writes the cross-respondent cohort report over a round of submissions — thematic analysis, segment comparisons, proposed charts, recommendations and actions, grounded in the aggregated results and (optionally) the client knowledge base. Dispatched by the cohort-report generation pipeline; not a chat agent.',
        systemInstructions: COHORT_REPORT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Analytical, low-variance prose.
        temperature: 0.3,
        // A multi-section report; reasoning models split this cap with internal reasoning.
        maxTokens: 8192,
        // A safety ceiling on cohort-report generation spend (shared agent monthly total).
        monthlyBudgetUsd: 50,
        // Reads the client KB by explicit documentIds allowlist (per-client tag scope), not the global corpus.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${COHORT_REPORT_AGENT_SLUG} agent`);
  },
};

export default unit;
