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
 *
 * Since F17.34 it also carries the Conditional Topics overlay — which topics exist, what phase each
 * runs in, and which of them claims each question — because a judge reading a flat list cannot tell
 * a broad opening question from the depth probe the planner seats *because of* how it was answered,
 * and the Duplicates judge was proposing to delete the second as redundant.
 */

import { prisma } from '@/lib/db/client';
import {
  parseAudienceShape,
  type StructureQuestion,
  type StructureRouting,
  type StructureSection,
  type StructureTopic,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';
import {
  narrowConditionalTopicsSettings,
  narrowTopicMembers,
} from '@/lib/app/questionnaire/scope/types';

/**
 * Build the routing overlay, or `undefined` when Conditional Topics is off for this version.
 *
 * `undefined` rather than a disabled block: absence is what keeps the judges' prompt byte-identical
 * to its pre-F17.34 form on the majority of questionnaires that do not use the feature.
 */
function buildRouting(
  config: { conditionalTopics: unknown } | null,
  topicRows: { key: string; label: string; phase: string; depth: string; members: unknown }[],
  questionKeys: Set<string>
): { routing: StructureRouting; topicKeysByQuestion: Map<string, string[]> } | null {
  const settings = narrowConditionalTopicsSettings(config?.conditionalTopics);
  if (!settings.enabled) return null;

  const topicKeysByQuestion = new Map<string, string[]>();
  const topics: StructureTopic[] = [];
  const conditionalQuestions = new Set<string>();

  for (const row of topicRows) {
    // Membership is keys, and an author who deletes a question leaves the key behind — so count and
    // attribute only the members that still resolve, or a topic reads as larger than it asks.
    const live = narrowTopicMembers(row.members).questionKeys.filter((k) => questionKeys.has(k));
    for (const key of live) {
      topicKeysByQuestion.set(key, [...(topicKeysByQuestion.get(key) ?? []), row.key]);
      if (row.phase === 'conditional') conditionalQuestions.add(key);
    }
    topics.push({
      key: row.key,
      label: row.label,
      phase: row.phase,
      depth: row.depth,
      questionCount: live.length,
    });
  }

  return {
    routing: {
      enabled: true,
      maxConditionalTopics: settings.maxConditionalTopics,
      topics,
      conditionalQuestionCount: conditionalQuestions.size,
    },
    topicKeysByQuestion,
  };
}

/**
 * Load the structure DTO for one version, scoped to its parent questionnaire (a
 * mismatched id/versionId pair returns `null` → 404 at the route). The version's
 * stored `audience` JSON is validated with {@link parseAudienceShape}, degrading a
 * malformed value to `null` rather than throwing.
 *
 * Config and topics come from the same `findFirst` as the sections, through the relations the
 * version already has. That is not tidiness: `evaluation-batch-apply.ts` calls this once per
 * finding for its live re-read, so a separate `loadTopics` + settings pair would double the
 * round-trips on every finding in a batch.
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
      config: { select: { conditionalTopics: true } },
      topics: {
        orderBy: { ordinal: 'asc' },
        select: { key: true, label: true, phase: true, depth: true, members: true },
      },
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

  const questionKeys = new Set(version.sections.flatMap((s) => s.questions.map((q) => q.key)));
  const overlay = buildRouting(version.config, version.topics, questionKeys);

  const sections: StructureSection[] = version.sections.map((section) => {
    const questions: StructureQuestion[] = section.questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      type: q.type,
      required: q.required,
      ...(q.guidelines ? { guidelines: q.guidelines } : {}),
      // An empty array is meaningful — routing is on and nothing claims this question, so it can
      // never be asked. That is exactly what a judge should not mistake for "unremarkable".
      ...(overlay ? { topicKeys: overlay.topicKeysByQuestion.get(q.key) ?? [] } : {}),
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
    ...(overlay ? { routing: overlay.routing } : {}),
  };
}
