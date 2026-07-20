/**
 * Experience step helpers — key derivation and ordinal placement.
 *
 * The Prisma seam for the two step operations that need to read siblings before writing. Kept out
 * of the route handlers so both the create route and (later) the import path share one definition
 * of "what key does this step get".
 */

import { prisma } from '@/lib/db/client';
import { slugifyStepKey } from '@/lib/app/questionnaire/experiences/types';

/**
 * Resolve the version a step should run: its pin, or the questionnaire's newest launched one.
 *
 * Shared by the run advance path (which version does the NEXT leg run?) and the step-report scope
 * (which version did these legs run?). Those two must never disagree — a report scoped to a
 * different version than the legs actually ran would resolve its data slots against the wrong
 * vocabulary and silently analyse nothing. Hence one definition, not two.
 *
 * Null when the step has no questionnaire, or its questionnaire has no launched, unarchived
 * version. Both are ordinary states for a half-authored journey, not errors.
 */
export async function resolveStepVersionId(step: {
  questionnaireId: string | null;
  versionId: string | null;
}): Promise<string | null> {
  if (step.versionId) return step.versionId;
  if (!step.questionnaireId) return null;

  const newest = await prisma.appQuestionnaireVersion.findFirst({
    where: { questionnaireId: step.questionnaireId, status: 'launched', archivedAt: null },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  return newest?.id ?? null;
}

/**
 * Derive a step key that is unique within its experience.
 *
 * Slugifies the title, then appends `-2`, `-3`, … until free. Suffixing rather than rejecting
 * matters because two steps legitimately share a title ("Follow-up" appearing twice in a long
 * journey is normal authoring), and an author should not have to invent a distinct name just to
 * satisfy a constraint they cannot see.
 *
 * Racy by nature — two concurrent creates can derive the same key. That is deliberate: the
 * `@@unique([experienceId, key])` constraint is the real arbiter and the route maps its P2002 to a
 * 409, so this only has to be right in the overwhelmingly common single-author case.
 */
export async function deriveStepKey(experienceId: string, title: string): Promise<string> {
  const base = slugifyStepKey(title);

  const existing = await prisma.appExperienceStep.findMany({
    where: { experienceId, key: { startsWith: base } },
    select: { key: true },
  });
  const taken = new Set(existing.map((s) => s.key));
  if (!taken.has(base)) return base;

  for (let n = 2; n <= taken.size + 2; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable: the loop bound exceeds the number of taken keys, so a free slot always exists.
  return `${base}-${taken.size + 2}`;
}

/** The ordinal a newly created step takes — the end of the list. */
export async function nextStepOrdinal(experienceId: string): Promise<number> {
  const last = await prisma.appExperienceStep.findFirst({
    where: { experienceId },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  return last ? last.ordinal + 1 : 0;
}
