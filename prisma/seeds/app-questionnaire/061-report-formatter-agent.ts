import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { REPORT_FORMATTER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Report Formatter agent — the second pass over a generated report. The formatting
 * pipeline (`lib/app/questionnaire/report/format.ts`) composes its own structured prompt; these
 * instructions set the agent's default remit and make it self-describing in the admin UI. The single
 * hard rule is fidelity: it reshapes form, never substance.
 */
const FORMATTER_INSTRUCTIONS = `You are the Report Formatter for the ConQuest app. You receive a \
report another agent already wrote — its summary, titled sections, and action items — and your ONLY \
job is to improve its form. You do three things: (1) re-paragraph the prose at natural, meaningful \
boundaries so each paragraph carries one idea, rather than one wall of text or lots of tiny uniform \
chunks; (2) where a passage really enumerates items, options, factors, or steps, turn it into a \
bullet list, one item per line starting with "- "; (3) strip AI-isms — reduce over-used em dashes \
(rewrite them as commas, full stops, or parentheses), and cut flowery or filler words and needless \
hedging so the writing reads plainly. You must NOT add, remove, merge, split, or reword any fact, \
claim, heading, section, or action beyond this formatting: keep every section and its heading, keep \
the second-person voice, and never introduce information that was not already there. You return the \
same structure you were given, reformatted.`;

/**
 * Seed the Report Formatter agent — the report-kind-agnostic second-pass formatter used by the
 * Respondent Report (and, later, opt-in by the Cohort Report). Loaded by slug from the formatting
 * pipeline. Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts`
 * (at the `chat` tier — formatting is largely mechanical, so it uses the cheaper/faster default).
 * `visibility: 'internal'` keeps it off public/embed picker surfaces.
 *
 * App seed: `SeedHistory` key `app-questionnaire/061-report-formatter-agent`. Idempotent — the
 * `update` branch re-asserts `isSystem: false` and re-applies the canonical persona so a changed
 * unit refreshes the agent's default voice on re-seed. (Pre-prod, no operator edits to preserve.)
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/061-report-formatter-agent',
  async run({ prisma, logger }) {
    logger.info('📝 Seeding report-formatter agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const description =
      'Second-pass formatter for generated reports: re-paragraphs prose, converts enumerations to bullet lists, and strips AI-isms (em-dash overuse, flowery filler) — without changing any fact, heading, section, or action. Dispatched by the report formatting pipeline; not a chat agent.';

    await prisma.aiAgent.upsert({
      where: { slug: REPORT_FORMATTER_AGENT_SLUG },
      // Re-apply the canonical persona on re-seed (pre-prod: no operator edits to preserve).
      update: { isSystem: false, systemInstructions: FORMATTER_INSTRUCTIONS, description },
      create: {
        name: 'Report Formatter',
        slug: REPORT_FORMATTER_AGENT_SLUG,
        description,
        systemInstructions: FORMATTER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (chat tier).
        model: '',
        provider: '',
        // Low temperature — this is a faithful reshape, not creative writing.
        temperature: 0.2,
        // Roughly the size of one report; reformatting is close to length-preserving.
        maxTokens: 8192,
        // A safety ceiling on formatter spend (shared agent monthly total).
        monthlyBudgetUsd: 25,
        // It never searches the KB (it only reshapes text it is handed); `restricted` keeps it off
        // the global corpus regardless, matching the report writer.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${REPORT_FORMATTER_AGENT_SLUG} agent`);
  },
};

export default unit;
