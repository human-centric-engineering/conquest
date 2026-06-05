import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
} from '@/lib/app/questionnaire/evaluation';

/**
 * Seed the seven design-time evaluation judges (F5.1).
 *
 * Each is a `kind = 'judge'` `AiAgent` — so it shows in the platform Judges surface,
 * reuses agent-resolver / cost / admin-edit — but it is a ConQuest **app** agent
 * (`isSystem: false`): editable, deletable, included in config backup/export, owned by
 * the service account only as the seeded `createdBy`.
 *
 * One seed file with a registry loop, mirroring the platform's
 * `016-evaluation-judges.ts`: the seven judges are a *set* (one panel), so a single
 * file beats the F4 one-agent-per-file convention. The dimension → slug/label/summary
 * registry lives in `lib/app/questionnaire/evaluation/dimensions.ts`, the single source
 * of truth the prompt builder and the preview route also read.
 *
 * **The load-bearing rubric lives in code, not here.** These judges are dispatched
 * app-natively (a structured `runStructuredCompletion` call per dimension), and the
 * capability builds the prompt from `judge-prompt.ts` — it does NOT read these
 * `systemInstructions`. The instructions exist so the judge is self-describing in the
 * admin UI and so any future chat-driven use has a sensible persona, the same split as
 * F4.5's completion agent (015). Tuning a judge's rubric is therefore a code change
 * (reviewed, git-diffable), not a DB edit.
 *
 * Ships with empty `model`/`provider` so each resolves dynamically via
 * `agent-resolver.ts` (the operator's configured judge / chat default). Low
 * `temperature` (judges should be near-deterministic). Idempotent — the `update`
 * branch only re-asserts `kind`/`isSystem` so re-seeding corrects a stray flag without
 * clobbering an operator's other edits (rubric, model, temperature).
 */

/** Compose a self-describing instruction for a judge from its registry summary. */
function judgeInstructions(label: string, summary: string): string {
  return `You are the ${label} in the ConQuest design-time evaluation panel. You review a \
conversational questionnaire's STRUCTURE (its goal, audience, sections, and questions) before \
launch and propose concrete edits. ${summary} You score only your own dimension on a continuous \
0.0–1.0 scale and emit actionable findings; a clean questionnaire yields no findings. You never \
see respondents or answers — you judge the authored design. (The exact rubric the engine sends is \
maintained in code; this description is for reference.)`;
}

const unit: SeedUnit = {
  name: 'app-questionnaire/018-design-evaluation-judges',
  async run({ prisma, logger }) {
    logger.info('⚖️  Seeding 7 design-time evaluation judge agents...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    for (const dimension of EVALUATION_DIMENSIONS) {
      const spec = EVALUATION_DIMENSION_SPECS[dimension];
      await prisma.aiAgent.upsert({
        where: { slug: spec.slug },
        // Re-assert only the platform-classification flags — never clobber an
        // operator's model/temperature/instruction edits (the rubric is in code).
        update: { kind: 'judge', isSystem: false },
        create: {
          name: spec.label,
          slug: spec.slug,
          description: spec.summary,
          systemInstructions: judgeInstructions(spec.label, spec.summary),
          kind: 'judge',
          // Empty strings → resolved at runtime via agent-resolver.ts using the
          // operator's configured judge / chat default. Provider-agnostic.
          model: '',
          provider: '',
          // Judges should be near-deterministic — same band as the platform judges.
          temperature: 0.2,
          // A findings array needs headroom beyond a one-line score; the same band as
          // the F4 extractor/detector.
          maxTokens: 2048,
          // A safety ceiling on each judge's spend, distinct from the others so one
          // can't starve the panel.
          monthlyBudgetUsd: 50,
          // Judges grade the authored structure, not a knowledge base — restrict KB
          // access so stray docs never leak into a verdict.
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

    logger.info(`✅ Seeded ${EVALUATION_DIMENSIONS.length} design-evaluation judge agents`);
  },
};

export default unit;
