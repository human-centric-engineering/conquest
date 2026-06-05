/**
 * Route-local version-structure loader for design-time evaluation (F5.1).
 *
 * Maps a questionnaire version's persisted graph (goal, audience, sections → slots)
 * into the pure {@link VersionStructureInput} DTO the judges read. This is the DB seam
 * — `lib/app/questionnaire/evaluation/**` stays Prisma-free, so all the
 * `findFirst`/select lives here, the same split as F4.1's `buildSelectionContext`.
 *
 * Unlike the selection/completion context, evaluation needs the *authored design*: the
 * version-level goal + audience and each section's title/description, not the
 * answered-so-far state (there is no respondent at design time).
 */

import { prisma } from '@/lib/db/client';
import {
  parseAudienceShape,
  type StructureQuestion,
  type StructureSection,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';

/**
 * Load the structure DTO for one version, scoped to its parent questionnaire (a
 * mismatched id/versionId pair returns `null` → 404 at the route). The version's
 * stored `audience` JSON is validated with {@link parseAudienceShape}, degrading a
 * malformed value to `null` rather than throwing.
 */
export async function buildEvaluationStructure(
  questionnaireId: string,
  versionId: string
): Promise<VersionStructureInput | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      goal: true,
      audience: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          title: true,
          description: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              key: true,
              prompt: true,
              type: true,
              required: true,
              guidelines: true,
            },
          },
        },
      },
    },
  });
  if (!version) return null;

  const sections: StructureSection[] = version.sections.map((section) => {
    const questions: StructureQuestion[] = section.questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      type: q.type,
      required: q.required,
      ...(q.guidelines ? { guidelines: q.guidelines } : {}),
    }));
    return {
      title: section.title,
      ...(section.description ? { description: section.description } : {}),
      questions,
    };
  });

  return {
    goal: version.goal ?? null,
    audience: parseAudienceShape(version.audience),
    sections,
  };
}
