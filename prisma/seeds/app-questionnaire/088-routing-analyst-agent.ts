import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * System-prompt context for the Routing Analyst.
 *
 * NOTE: the analyst builds its own structured prompt in
 * `lib/app/questionnaire/scope/analysis-prompt.ts` and does NOT read these instructions at runtime
 * — they exist so the agent is self-describing in the admin UI and the prompt library. The
 * load-bearing rules live in that module.
 */
const ANALYST_INSTRUCTIONS = `You read questionnaire instruments — on any subject, in whatever shape \
their author wrote them — and work out which parts of them apply to whom.

Structure extraction reads a document for its questions and throws the rest away. You read what it \
threw away: routing and skip-logic notes, eligibility rules, guardrails, facilitator instructions, \
the "how to use this" guidance — wherever in the file the author put them. That material is the \
author stating, in their own words, which sections are for which respondents, how many areas one \
session should cover, and what must never be asked of certain people.

Your output is a proposal an administrator reviews, so the most valuable thing you produce is not \
the taxonomy — it is the evidence. When the document states a rule you quote it and write the \
criteria in the author's own language. When it says nothing and you are inferring from section \
headings, you say so plainly and attach no quote. A guess that looks authored gets accepted, and \
then the instrument routes on your invention rather than the author's rule; that is the one failure \
that matters here.`;

/**
 * Seed the Routing Analyst agent (Conditional Topics, P17.4).
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` — the
 * analyst asks for the `reasoning` tier, since reading prose instructions and turning them into a
 * covering topic set is a comprehension task, not a formatting one.
 *
 * `maxTokens` is large and the route's timeout generous, unlike the Scope Planner's: **no
 * respondent is waiting**. An admin clicked a button and is watching a progress stream, so this run
 * can afford to read an entire instrument carefully where the planner cannot afford to think for
 * more than twelve seconds.
 *
 * App seed: `SeedHistory` key `app-questionnaire/088-routing-analyst-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false` so re-seeding corrects a stray system flag
 * without clobbering an operator's model or budget edits.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/088-routing-analyst-agent',
  async run({ prisma, logger }) {
    logger.info('🧭 Seeding Routing Analyst agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Routing Analyst',
        slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
        description:
          'Reads the author’s guidance in an uploaded instrument and proposes the conditional-topics ' +
          'topics and hard rules it describes, each traced back to the span it came from. A proposer — ' +
          'everything it returns lands in a draft for an admin to review.',
        systemInstructions: ANALYST_INSTRUCTIONS,
        // Empty strings — resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Near-deterministic: the same instrument should yield the same topic set twice. Reading
        // an author's routing rules is comprehension, not invention.
        temperature: 0.2,
        // Up to 40 topics with criteria, rationale and a quoted span each, plus rules. Reasoning
        // models split this cap with their own reasoning, so it is not as generous as it looks.
        maxTokens: 12288,
        // Safety ceiling on analysis spend across all questionnaires.
        monthlyBudgetUsd: 25,
        // Reasons over the supplied instrument, never a knowledge base.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG} agent`);
  },
};

export default unit;
