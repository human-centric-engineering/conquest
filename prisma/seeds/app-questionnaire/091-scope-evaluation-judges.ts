import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import {
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
} from '@/lib/app/questionnaire/scope-evaluation';

/**
 * Seed the four Adaptive Scope evaluation judges (F17.21).
 *
 * Each is a `kind = 'judge'` `AiAgent`, the same shape as the design-evaluation judges
 * (`018-design-evaluation-judges.ts`) — editable, deletable, included in config backup/export,
 * owned by the service account only as the seeded `createdBy`.
 *
 * **The load-bearing rubric lives in code, not here.** These judges are dispatched app-natively
 * (a structured `runStructuredCompletion` call per dimension) and the `evaluate-scope` capability
 * builds the prompt from `judge-prompt.ts` — it does NOT read these `systemInstructions`. The
 * instructions exist so the judge is self-describing in the admin UI. Tuning a judge's rubric is
 * therefore a code change (reviewed, git-diffable), not a DB edit.
 *
 * Ships with empty `model`/`provider` so each resolves dynamically via `agent-resolver.ts`. Low
 * `temperature` (judges should be near-deterministic). Idempotent — the `update` branch only
 * re-asserts `kind`/`isSystem` so re-seeding corrects a stray flag without clobbering an operator's
 * other edits.
 */

/** Compose a self-describing instruction for a judge from its registry summary. */
function judgeInstructions(label: string, summary: string): string {
  return `You are the ${label} in the ConQuest Adaptive Scope evaluation panel. You review a \
questionnaire version's ADAPTIVE SCOPE configuration — its topics, hard rules, planner instructions \
and time budget — before launch and propose concrete edits. ${summary} You score only your own \
dimension on a continuous 0.0–1.0 scale and emit actionable findings; a well-designed config yields \
no findings. Where a fix maps cleanly to a concrete edit, you attach a structured "proposedEdit" the \
review queue can apply in one click; otherwise you describe it in prose. You never see respondents \
or live sessions — you judge the authored design. (The exact rubric the engine sends is maintained \
in code; this description is for reference.)`;
}

const unit: SeedUnit = {
  name: 'app-questionnaire/091-scope-evaluation-judges',
  async run({ prisma, logger }) {
    logger.info('⚖️  Seeding 4 Adaptive Scope evaluation judge agents...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const spec = SCOPE_EVALUATION_DIMENSION_SPECS[dimension];
      await prisma.aiAgent.upsert({
        where: { slug: spec.slug },
        // Re-assert only the platform-classification flags — never clobber an operator's
        // model/temperature/instruction edits (the rubric is in code).
        update: { kind: 'judge', isSystem: false },
        create: {
          name: spec.label,
          slug: spec.slug,
          description: spec.summary,
          systemInstructions: judgeInstructions(spec.label, spec.summary),
          kind: 'judge',
          // Empty strings → resolved at runtime via agent-resolver.ts using the operator's
          // configured judge / chat default. Provider-agnostic.
          model: '',
          provider: '',
          // Judges should be near-deterministic — same band as the design-evaluation judges.
          temperature: 0.2,
          maxTokens: 2048,
          // A safety ceiling on each judge's spend, distinct from the others so one can't
          // starve the panel.
          monthlyBudgetUsd: 50,
          // Judges grade the authored config, not a knowledge base — restrict KB access so
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
      logger.info(`  ✓ ${spec.slug}`);
    }

    logger.info(`✅ Seeded ${SCOPE_EVALUATION_DIMENSIONS.length} scope-evaluation judge agents`);
  },
};

export default unit;
