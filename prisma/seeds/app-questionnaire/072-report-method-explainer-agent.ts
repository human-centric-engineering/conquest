import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { REPORT_METHOD_EXPLAINER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Report Method Explainer — the meta-agent behind the respondent-facing "How this
 * report was created" panel. The summary pipeline
 * (`lib/app/questionnaire/report/method-summary.ts`) composes the operative prompt and machine-checks
 * the output; these instructions set the agent's remit and make it self-describing in the admin UI.
 *
 * The single hard rule is honesty about process. This agent is asked to reassure, which is precisely
 * why it must not be allowed to embellish: it describes only the steps the record says ran, states no
 * number the record doesn't contain, and never characterises the process as more thorough than it was.
 */
const EXPLAINER_INSTRUCTIONS = `You are the Report Method Explainer for the ConQuest app. You are \
given a factual record of the steps that were taken to produce one person's report — which of their \
answers were read, whether their unanswered questions were noted as gaps, whether their \
organisation's documents were consulted, whether any web research ran, and which checking passes \
were applied. Your job is to turn that record into a short, plain-English explanation addressed to \
that person, so they understand how their report was put together. Write calmly and factually, in \
everyday language: no technical jargon, no product names, no internal terminology. You describe ONLY \
what the record states. You never mention a step that did not run, never imply a check that is not \
recorded, never state a number that is not in the record, and never claim the process was thorough, \
rigorous, or comprehensive — you describe what was done and let the reader judge. You never discuss \
what the report says, only how it was made.`;

/**
 * Seed the Report Method Explainer agent — the report-kind-agnostic meta-agent that narrates a run's
 * method record. Loaded by slug from the summary pipeline. Ships with empty `model`/`provider` so it
 * resolves dynamically via `agent-resolver.ts` (at the `chat` tier — a short constrained rewrite of a
 * structured digest). `visibility: 'internal'` keeps it off public/embed picker surfaces.
 *
 * App seed: `SeedHistory` key `app-questionnaire/072-report-method-explainer-agent`. Idempotent — the
 * `update` branch re-asserts `isSystem: false` and re-applies the canonical persona so a changed unit
 * refreshes the agent's default voice on re-seed. (Pre-prod, no operator edits to preserve.)
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/072-report-method-explainer-agent',
  async run({ prisma, logger }) {
    logger.info('🔍 Seeding report-method-explainer agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const description =
      'Meta-agent for the respondent-facing "How this report was created" panel: turns the factual record of a report run (answers read, gaps noted, documents consulted, searches run, checks applied) into a short plain-English explanation. Sees only the record — never the report, the answers, or the sources — and its output is machine-checked for ungrounded numbers before it is shown. Dispatched by the report summary pipeline; not a chat agent.';

    await prisma.aiAgent.upsert({
      where: { slug: REPORT_METHOD_EXPLAINER_AGENT_SLUG },
      // Re-apply the canonical persona on re-seed (pre-prod: no operator edits to preserve).
      update: { isSystem: false, systemInstructions: EXPLAINER_INSTRUCTIONS, description },
      create: {
        name: 'Report Method Explainer',
        slug: REPORT_METHOD_EXPLAINER_AGENT_SLUG,
        description,
        systemInstructions: EXPLAINER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (chat tier).
        model: '',
        provider: '',
        // Low temperature — this is a faithful restatement of a record, not creative writing.
        temperature: 0.2,
        // A few sentences; the pipeline caps output well below this.
        maxTokens: 1024,
        // A safety ceiling on explainer spend (shared agent monthly total). Small: one cheap call
        // per generated report.
        monthlyBudgetUsd: 10,
        // It never searches the KB (it only restates a record it is handed); `restricted` keeps it
        // off the global corpus regardless, matching the report writer and formatter.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${REPORT_METHOD_EXPLAINER_AGENT_SLUG} agent`);
  },
};

export default unit;
