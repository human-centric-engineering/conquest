import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_EDIT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the structure edit agent. NOTE: the plan route builds its own
 * structured prompt via `edit-agent/translate-prompt.ts` and does NOT read these instructions —
 * they exist so the agent is self-describing in the admin UI (and Agent Settings) and so any future
 * chat-driven use has a sensible persona. The load-bearing translation rules live in
 * `lib/app/questionnaire/edit-agent/translate-prompt.ts`.
 */
const EDIT_AGENT_INSTRUCTIONS = `You are the questionnaire structure editor for the ConQuest app. \
Given a draft questionnaire and a plain-English instruction about the WHOLE document ("renumber the \
sections", "use CAPS for every section title", "remove required from all free-text questions"), you \
translate it into a precise list of structural edit operations. You never rewrite question wording \
unless explicitly asked; you prefer the smallest set of operations that fully satisfies the \
instruction, and you only touch what the instruction names.`;

/**
 * Seed the questionnaire structure-edit agent (precise instruction-driven editing).
 *
 * The plan route resolves this agent's binding to run one structured completion that turns the
 * admin's instruction into an edit-op plan; the agent carries the budget cap and the
 * provider-agnostic binding. It ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`. `visibility: 'internal'` keeps it off public/embed surfaces. A distinct agent
 * from the composer and advisor: surgical editing carries its own budget and persona.
 *
 * App seed: `SeedHistory` key `app-questionnaire/060-edit-agent`. Idempotent — the `update` branch
 * only re-asserts `isSystem: false` so re-seeding corrects any stray system flag without clobbering
 * an operator's edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/060-edit-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire structure-edit agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_EDIT_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Structure Edit Agent',
        slug: QUESTIONNAIRE_EDIT_AGENT_SLUG,
        description:
          'Turns a plain-English instruction for a whole draft questionnaire (renumber sections, ' +
          'CAPS titles, strip required from free-text fields) into a deterministic edit-op plan ' +
          'applied via a preview-then-confirm panel on the Structure editor. Dispatched by the ' +
          'edit-agent API; not a chat agent.',
        systemInstructions: EDIT_AGENT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Faithful interpretation, not creative phrasing — keep it low.
        temperature: 0.2,
        // The plan is a compact JSON list of edit-ops, not a full structure.
        maxTokens: 4096,
        // A safety ceiling on edit-planning spend. The routes add a per-admin sub-cap; this caps
        // the shared agent's monthly total.
        monthlyBudgetUsd: 25,
        // The editor reasons over the supplied structure, not a knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_EDIT_AGENT_SLUG} agent`);
  },
};

export default unit;
