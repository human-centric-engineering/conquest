import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_STEER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the suggestion steer agent. NOTE: the batch-apply leg builds its own
 * structured prompt via `evaluation/steer-prompt.ts` and does NOT read these instructions — they
 * exist so the agent is self-describing in the admin UI (and Agent Settings), and so the binding
 * has a sensible persona if it is ever driven from a chat surface. The load-bearing rules live in
 * `lib/app/questionnaire/evaluation/steer-prompt.ts`.
 */
const STEER_AGENT_INSTRUCTIONS = `You reword one already-approved change to a questionnaire so that \
it follows the reviewer's own instruction. A judge proposed the change and a human accepted it: your \
job is that same change, in their words. You never switch the change for a different one, never \
decide a question should be moved, retyped or removed, and never quietly do half of what was asked \
— anything wording alone cannot fix, you name.`;

/**
 * Seed the suggestion steer agent (the AI leg of design-evaluation batch apply).
 *
 * A distinct agent from the Structure Edit Agent, whose persona is the opposite of this one's: that
 * agent reads an instruction about a whole document and never rewrites wording, this one rewrites
 * the wording of exactly one accepted change. Ships with empty `model`/`provider` so it resolves
 * dynamically via `agent-resolver.ts`. `visibility: 'internal'` keeps it off public/embed surfaces.
 *
 * App seed: `SeedHistory` key `app-questionnaire/098-suggestion-steer-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false`, so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget choices.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/098-suggestion-steer-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding questionnaire suggestion steer agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_STEER_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Suggestion Steer',
        slug: QUESTIONNAIRE_STEER_AGENT_SLUG,
        description:
          'Rewrites one accepted design-evaluation suggestion so it follows the instruction the ' +
          'reviewer attached to it, then hands it back as the same kind of change for the ' +
          'deterministic apply path. Dispatched once per steered finding by the batch-apply ' +
          'route; not a chat agent.',
        systemInstructions: STEER_AGENT_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts.
        model: '',
        provider: '',
        // Following a constraint faithfully, not writing freely — keep it low.
        temperature: 0.2,
        // One rewritten change plus two short lines of prose.
        maxTokens: 2048,
        // A safety ceiling on steer spend: one call per steered finding, and a reviewer can steer
        // every finding in a run. The routes add a per-admin sub-cap; this caps the monthly total.
        monthlyBudgetUsd: 25,
        // It reasons over the change and the questionnaire it was given, not a knowledge base.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_STEER_AGENT_SLUG} agent`);
  },
};

export default unit;
