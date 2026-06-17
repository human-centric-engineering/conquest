import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

/**
 * Seed the `turn-evaluator` judge agent.
 *
 * A `kind = 'judge'` `AiAgent` — so it shows in the platform Judges surface and reuses
 * agent-resolver / cost / admin-edit — but it is a ConQuest **app** agent (`isSystem: false`):
 * editable, deletable, included in config backup/export, owned by the service account only as
 * the seeded `createdBy`. The evaluate-turn route reads this agent's `{ provider, model,
 * fallbackProviders }` binding and passes it to the `evaluateTurn` service.
 *
 * **The load-bearing rubric lives in code, not here.** The evaluator is dispatched app-natively
 * (a structured `runStructuredCompletion` call), and the prompt is built from
 * `turn-evaluation/prompt.ts` — it does NOT read these `systemInstructions`. The instructions
 * exist so the agent is self-describing in the admin UI and so any future chat-driven use has a
 * sensible persona, the same split as the design-evaluation judges (018). Tuning the rubric is
 * therefore a code change (reviewed, git-diffable), not a DB edit.
 *
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (the
 * operator's configured judge / chat default, `reasoning` tier at call time). Low `temperature`
 * (the evaluator should be near-deterministic) and a generous `maxTokens` (the verdict is a
 * large multi-section object). Idempotent — the `update` branch only re-asserts `kind`/`isSystem`
 * so re-seeding corrects a stray flag without clobbering an operator's other edits.
 */

const SLUG = 'turn-evaluator';

const SYSTEM_INSTRUCTIONS = `You are the ConQuest turn evaluator — a specialist interview-quality \
evaluator. You analyse ONE completed turn of an AI-driven interview (all the LLM calls between one \
respondent answer and the next interviewer question) and produce a structured, scored evaluation \
for developers, researchers, and prompt engineers. You judge instruction compliance, interviewing \
quality, extraction quality, question-selection quality, information gain, missed opportunities, \
prompt drift, and cost/efficiency — always comparing each call's output against the prompt that \
produced it, never from outputs alone, and never inventing a call that did not run. You do not see \
respondents; you grade the system's behaviour. (The exact rubric the engine sends is maintained in \
code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/043-turn-evaluator-agent',
  async run({ prisma, logger }) {
    logger.info('⚖️  Seeding the turn-evaluator judge agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: SLUG },
      // Re-assert only the platform-classification flags — never clobber an operator's
      // model/temperature/instruction edits (the rubric is in code).
      update: { kind: 'judge', isSystem: false },
      create: {
        name: 'Turn Evaluator',
        slug: SLUG,
        description:
          'Interview-quality evaluator for a single completed turn — run from the Preview Turn ' +
          'Inspector.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        kind: 'judge',
        // Empty strings → resolved at runtime via agent-resolver.ts using the operator's
        // configured judge / chat default. Provider-agnostic.
        model: '',
        provider: '',
        // The evaluator should be near-deterministic — same band as the design judges.
        temperature: 0.2,
        // The verdict is a large multi-section object — generous headroom (matches the
        // service's TURN_EVAL_MAX_TOKENS).
        maxTokens: 4096,
        // A safety ceiling on the evaluator's spend.
        monthlyBudgetUsd: 50,
        // The evaluator grades a turn dump, not a knowledge base — restrict KB access so
        // stray docs never leak into a verdict.
        knowledgeAccessMode: 'restricted',
        // Internal-only: never surfaced on public/embed picker surfaces.
        visibility: 'internal',
        isActive: true,
        // App component, not a platform/system agent.
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${SLUG} judge agent`);
  },
};

export default unit;
