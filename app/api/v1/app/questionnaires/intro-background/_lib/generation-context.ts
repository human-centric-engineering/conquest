/**
 * Intro-background generation context (F12.2).
 *
 * Formats a single version's **goal + questions** into a compact, plain-text summary the intro-author
 * route injects into a `generate` call when the admin ticks "use the questionnaire goal and questions
 * to help generate the intro". This grounds the drafted intro in what the questionnaire actually
 * covers without the admin re-typing it.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` capability is Prisma-free, so the load + format
 * lives here and the result is passed through as an opaque string (`questionnaireContext`).
 */

import { prisma } from '@/lib/db/client';

/** Cap the questions folded into the prompt — enough to convey scope, bounded so the prompt stays small. */
const MAX_QUESTIONS = 80;
/** Overall cap on the formatted context (chars) — a backstop against a very long goal + question set. */
const MAX_CONTEXT_CHARS = 6_000;

/**
 * Load + format the goal and question prompts for `versionId` (scoped to `questionnaireId`, so a
 * mismatched pair yields `null` rather than leaking another questionnaire's structure). Returns
 * `null` when the version is absent or has neither a goal nor any questions — the route then simply
 * generates from the brief alone.
 */
export async function loadIntroGenerationContext(
  questionnaireId: string,
  versionId: string
): Promise<string | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      goal: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          questions: {
            orderBy: { ordinal: 'asc' },
            select: { prompt: true },
          },
        },
      },
    },
  });
  if (!version) return null;

  const goal = version.goal?.trim() ?? '';
  const prompts = version.sections
    .flatMap((s) => s.questions)
    .map((q) => q.prompt.trim())
    .filter((p) => p.length > 0);

  if (goal.length === 0 && prompts.length === 0) return null;

  const parts: string[] = [];
  if (goal.length > 0) parts.push(`Goal of this questionnaire:\n${goal}`);
  if (prompts.length > 0) {
    const shown = prompts.slice(0, MAX_QUESTIONS);
    const list = shown.map((p) => `- ${p}`).join('\n');
    const more =
      prompts.length > shown.length ? `\n- …and ${prompts.length - shown.length} more` : '';
    parts.push(`Questions it asks:\n${list}${more}`);
  }

  return parts.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
}
