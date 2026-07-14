import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { REPORT_RESEARCHER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the Report Research agent. The research module
 * (`lib/app/questionnaire/report/research.ts`) composes its own per-phase prompt and layers the
 * admin's instruction on top; this persona sets the agent's default behaviour and self-description.
 */
const RESEARCHER_INSTRUCTIONS = `You are the Report Research agent for the ConQuest app. You gather \
live external context from the public web to inform or enrich a report. You are given a task from the \
report author and a round budget. You issue ONE focused web_search query per call and refine each \
subsequent query based on what the previous results returned — never repeating a query and building \
progressively on what you have learned. You rely only on results the tool actually returns; you never \
invent sources, URLs, or facts. When you have gathered enough, you stop searching and write a brief, \
neutral synthesis of what you found and why it matters for the task. You prefer credible, primary, and \
recent sources.`;

/**
 * Seed the Report Research agent (report kind–agnostic: respondent now, cohort later).
 *
 * Drives the report's web-search rounds via a `web_search` tool loop. Loaded by slug from the research
 * module. Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` — the
 * research module resolves it at the `reasoning` tier (query refinement + synthesis is reasoning-heavy).
 * `visibility: 'internal'` keeps it off public/embed picker surfaces. A distinct agent from the report
 * writer — research carries its own budget and persona. The `web_search` capability is bound in
 * `071-web-search-capability.ts` (runs after this).
 *
 * App seed: `SeedHistory` key `app-questionnaire/070-report-researcher-agent`. Idempotent — the
 * `update` branch re-asserts `isSystem: false` and re-applies the canonical persona.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/070-report-researcher-agent',
  async run({ prisma, logger }) {
    logger.info('🔎 Seeding report-researcher agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const description =
      'Gathers live external web context for report generation via a web_search tool loop (before and/or after a report is written). Dispatched by the report research module; not a chat agent.';

    await prisma.aiAgent.upsert({
      where: { slug: REPORT_RESEARCHER_AGENT_SLUG },
      // Re-apply the canonical persona on re-seed (pre-prod: no operator edits to preserve).
      update: { isSystem: false, systemInstructions: RESEARCHER_INSTRUCTIONS, description },
      create: {
        name: 'Report Research Agent',
        slug: REPORT_RESEARCHER_AGENT_SLUG,
        description,
        systemInstructions: RESEARCHER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Focused, low-variance query formulation and synthesis.
        temperature: 0.3,
        // Per-turn cap; the loop makes several short turns, so this need not be large.
        maxTokens: 2048,
        // A safety ceiling on research spend (shared agent monthly total).
        monthlyBudgetUsd: 25,
        // No knowledge-base access — it researches the public web, not the corpus.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${REPORT_RESEARCHER_AGENT_SLUG} agent`);
  },
};

export default unit;
