import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { EXPERIENCE_SYNTHESIS_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

/**
 * System-prompt context for the experience-wide synthesiser.
 *
 * NOTE: like the breakout synthesiser, this agent builds its real structured prompt in code
 * (`lib/app/questionnaire/experiences/synthesis/generate.ts`) and does NOT read these instructions
 * at runtime — they exist so the agent is self-describing in the admin UI. The load-bearing rules,
 * including citation discipline, live in that module.
 */
const SYNTHESISER_INSTRUCTIONS = `Several questionnaires have already been reported on \
individually — one report per step of a journey, or one set of findings per breakout of a meeting. \
You read those finished reports side by side and write the layer above them: what the journey \
showed as a whole.

You are looking for the two things no single report can contain. First, what holds ACROSS the \
steps — a pattern that needed more than one of them to see. Second, where the journey disagreed \
with ITSELF: two branches pointing opposite ways, a group that broke from the rest, a theme that \
reversed between one step and the next. Anything visible in a single step's report belongs in that \
report, not in yours.

You cite the steps behind every claim, because a reader must be able to go and check it. You never \
invent a number. You describe groups, never individuals. When the reports genuinely agree, you say \
so plainly rather than manufacturing a contrast to fill a section.`;

/**
 * Seed the experience-wide synthesiser agent (P15.8).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` at the
 * `reasoning` tier — holding several reports side by side and noticing where they diverge is a
 * judgement task, not an extraction one.
 *
 * Like the breakout synthesiser and unlike the routing selector, **nobody is waiting on a spinner
 * mid-conversation**: an admin pressed a button deliberately. So this gets a long timeout and a
 * large token budget, and correctness beats latency.
 *
 * Its token ceiling is the largest of the three experience agents because its INPUT is largest —
 * several finished step reports, each already a page of prose.
 *
 * App seed: `SeedHistory` key `app-questionnaire/083-experience-synthesiser-agent`. Idempotent —
 * the `update` branch only re-asserts `isSystem: false`, so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/083-experience-synthesiser-agent',
  async run({ prisma, logger }) {
    logger.info('📋 Seeding experience-wide synthesiser agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: EXPERIENCE_SYNTHESIS_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Experience Synthesiser',
        slug: EXPERIENCE_SYNTHESIS_AGENT_SLUG,
        description:
          'Writes the across-the-whole-journey view for an experience: a narrative, findings that ' +
          'cite the steps behind them, and the divergences only a cross-step view can see. Reads ' +
          'FINISHED step reports and breakout findings, never raw sessions. Dispatched when an ' +
          'admin generates the experience-wide synthesis; not a chat agent.',
        systemInstructions: SYNTHESISER_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Low: the value here is faithful cross-reading, and the phrasing matters less than it does
        // for the breakout synthesiser (nobody reads this aloud to a room).
        temperature: 0.25,
        // The largest of the three experience agents — several full step reports go in.
        maxTokens: 6144,
        // Safety ceiling on synthesis spend across all experiences.
        monthlyBudgetUsd: 25,
        // Reasons over the supplied reports only, never a knowledge base.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${EXPERIENCE_SYNTHESIS_AGENT_SLUG} agent`);
  },
};

export default unit;
