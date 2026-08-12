import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { RECONCILER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the Suggestion Reconciler agent (design evaluation).
 *
 * Runs once after the judge panel, over the questions MORE THAN ONE judge flagged, and proposes
 * wording that satisfies as many of their concerns as it can at once. It exists because the panel's
 * independence — every judge blind to the others, which is what makes the scores trustworthy — hands
 * the admin several rewrites of the same question, each fixing one dimension and quietly undoing
 * another.
 *
 * Note it is **not** a judge: no dimension, no score, `kind` left at the default rather than
 * `'judge'`, so it never appears in the panel's dimension list or the Judges admin surface. The
 * evaluation routes load it by slug in a separate OR arm of the agent query for exactly that reason.
 *
 * **The load-bearing rubric lives in code, not here.** It is dispatched app-natively (a structured
 * `runStructuredCompletion` call) with the prompt built from `evaluation/reconcile-prompt.ts` — it
 * does NOT read these `systemInstructions`, which exist so the agent is self-describing in the admin
 * UI (the same split as the judges, the extractor and the glossary analyst). Ships with empty
 * `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (`reasoning` tier at call
 * time). Idempotent — `update` only re-asserts `isSystem` so re-seeding never clobbers an operator's
 * edits.
 */

const SLUG = RECONCILER_AGENT_SLUG;

const SYSTEM_INSTRUCTIONS = `You are the ConQuest Suggestion Reconciler. A panel of independent \
judges has reviewed one questionnaire, each on a single dimension and none of them aware of the \
others. Where several judges flagged the SAME question, you propose one — or at most two — \
alternative phrasings that satisfy as many of their concerns as possible at once, so an \
administrator makes one decision instead of choosing between rewrites that undo each other. You \
never buy one judge's fix with another's, you keep the question's intent intact, and you say plainly \
which concerns each phrasing resolves and which no wording of yours can (usually because the real \
fix is structural — splitting the question, changing its answer type). You propose only; an \
administrator accepts, edits, or ignores every alternative. (The exact rubric the engine sends is \
maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/086-suggestion-reconciler-agent',
  async run({ prisma, logger }) {
    logger.info('🤝 Seeding the Suggestion Reconciler agent...');

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
        name: 'Suggestion Reconciler',
        slug: SLUG,
        description:
          "Merges several judges' verdicts about the same question into one or two alternative " +
          'phrasings that satisfy as many of their concerns as possible, naming what each resolves ' +
          'and what wording alone cannot.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // Empty strings → resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Warmer than the judges (0.2): they classify against a rubric, this one writes. Rewriting
        // a question so it survives six critiques at once needs some room to find the phrasing.
        temperature: 0.3,
        // Up to 15 questions × 2 alternatives, each a full rewrite plus a note — and on a reasoning
        // model this budget also absorbs the hidden reasoning tokens.
        maxTokens: 8192,
        monthlyBudgetUsd: 25,
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
