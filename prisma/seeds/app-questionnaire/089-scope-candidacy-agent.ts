import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the Conditional Topics candidacy-check agent (P17.19).
 *
 * A cheap, fast triage read that runs on every fresh questionnaire ingestion: does the uploaded
 * document's own text describe routing different respondents through different parts of it? Not
 * the Routing Analyst (`088-routing-analyst-agent.ts`) — this only decides whether that analysis is
 * worth running automatically. A ConQuest **app** agent (`isSystem: false`): editable, deletable,
 * in config backup/export.
 *
 * **The load-bearing rubric lives in code, not here.** Dispatched app-natively (a structured
 * `runStructuredCompletion` call) with the prompt built from `scope/candidacy-prompt.ts` — it does
 * NOT read these `systemInstructions`; they exist so the agent is self-describing in the admin UI.
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (the
 * `routing` tier at call time — this must stay cheap, it runs on every upload). Idempotent —
 * `update` only re-asserts `isSystem` so re-seeding never clobbers an operator's edits.
 */

const SLUG = QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG;

const SYSTEM_INSTRUCTIONS = `You are a fast triage check for ConQuest's questionnaire ingestion \
pipeline. Given a freshly-uploaded document, you decide ONLY whether its own words describe routing \
different respondents through different parts of the instrument — eligibility notes, routing or \
guardrail guidance, skip logic, facilitator instructions naming who answers what, wherever in the \
file they sit and whatever the subject matter. You do not propose \
topics or rules; that is a separate analyst's job, run only when you say yes. (The exact rubric the \
engine sends is maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/089-scope-candidacy-agent',
  async run({ prisma, logger }) {
    logger.info('🔎 Seeding the Conditional Topics candidacy-check agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: SLUG },
      update: { isSystem: false },
      create: {
        name: 'Conditional Topics Candidacy Check',
        slug: SLUG,
        description:
          'Cheap triage read that flags a freshly-uploaded questionnaire as a Conditional Topics ' +
          'candidate when its own text describes conditional routing.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // Empty strings → resolved at runtime via agent-resolver.ts (routing tier).
        model: '',
        provider: '',
        // Near-deterministic triage read — same band as the extraction verifier.
        temperature: 0.2,
        // Verdict + a handful of signals stays small.
        maxTokens: 1024,
        monthlyBudgetUsd: 15,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${SLUG} agent`);
  },
};

export default unit;
