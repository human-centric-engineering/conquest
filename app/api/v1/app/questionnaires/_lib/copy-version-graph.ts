/**
 * Deep-copy a version's structural graph from one version into another.
 *
 * Single-sources the "what a version copy includes" contract for the two callers that
 * duplicate a version's structure: the F2.1 version fork ({@link forkVersionIfLaunched})
 * and the clone-for-client utility. Copies, within a caller-supplied transaction, into
 * an already-created (empty) target version:
 *   - the run-time config row (F3.1, 1:1 with the version) when one exists,
 *   - the section → question-slot graph (ordinals verbatim; per-version-unique `key`s
 *     carried 1:1, so uniqueness holds by construction),
 *   - the tag vocabulary (F2.2) with each assignment re-linked to the copied slot.
 *
 * Returns the old→new id maps so a caller can retarget anything that references the
 * originals (the fork's child-mutation retarget; not needed by clone).
 *
 * Goal / audience / provenance live on the version *row* and are set by each caller at
 * version-create (a fork keeps them, a clone copies them) — NOT here. Deliberately not
 * copied: extraction-change records (a copy starts a clean editorial lineage),
 * sessions, invitations, answers, turns, evaluation runs.
 *
 * Route-local DB seam — `lib/app/questionnaire/**` stays Prisma-free.
 */

import { executeTransaction } from '@/lib/db/utils';
import { CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

/** The transaction client `executeTransaction` hands its callback (mirrors persist.ts). */
type CopyTx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/** Old→new id maps for everything copied, so callers can re-link references. */
export interface CopiedGraphMaps {
  sectionIdMap: Map<string, string>;
  questionIdMap: Map<string, string>;
  tagIdMap: Map<string, string>;
}

/**
 * Copy `sourceVersionId`'s config + section/slot graph + tag vocabulary into the
 * already-created `targetVersionId`, inside `tx`. Returns the old→new id maps.
 */
export async function copyVersionGraph(
  tx: CopyTx,
  sourceVersionId: string,
  targetVersionId: string
): Promise<CopiedGraphMaps> {
  const source = await tx.appQuestionnaireVersion.findUniqueOrThrow({
    where: { id: sourceVersionId },
    select: {
      // Reuse the read view's column set so a new config column is copied automatically
      // — no separate list here to fall out of sync (F3.1).
      config: { select: CONFIG_SELECT },
      tags: {
        select: {
          id: true,
          label: true,
          normalizedLabel: true,
          color: true,
          slots: { select: { questionSlotId: true } },
        },
      },
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          ordinal: true,
          title: true,
          description: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              ordinal: true,
              key: true,
              prompt: true,
              guidelines: true,
              rationale: true,
              type: true,
              typeConfig: true,
              required: true,
              weight: true,
              extractionConfidence: true,
            },
          },
        },
      },
    },
  });

  // F3.1: copy the run-time config row when one exists (1:1 with the version). A
  // no-config source copies to a no-config target — both resolve to the same defaults.
  if (source.config) {
    await tx.appQuestionnaireConfig.create({
      data: {
        versionId: targetVersionId,
        // Spread the selected columns (CONFIG_SELECT) verbatim; only the JSON column
        // needs the null-sentinel wrapper. New columns ride along.
        ...source.config,
        profileFields: jsonInput(source.config.profileFields),
      },
    });
  }

  // Sections first (slots reference them); copy ordinal verbatim, mapping each original
  // section id to its copy so a caller can retarget child mutations.
  const sectionIdMap = new Map<string, string>();
  for (const section of source.sections) {
    const newSection = await tx.appQuestionnaireSection.create({
      data: {
        versionId: targetVersionId,
        ordinal: section.ordinal,
        title: section.title,
        ...(section.description !== null ? { description: section.description } : {}),
      },
      select: { id: true },
    });
    sectionIdMap.set(section.id, newSection.id);

    if (section.questions.length > 0) {
      await tx.appQuestionSlot.createMany({
        data: section.questions.map((q) => ({
          versionId: targetVersionId,
          sectionId: newSection.id,
          ordinal: q.ordinal,
          key: q.key, // copied 1:1 into a fresh version — uniqueness holds by construction
          prompt: q.prompt,
          type: q.type,
          required: q.required,
          weight: q.weight,
          ...(q.guidelines !== null ? { guidelines: q.guidelines } : {}),
          ...(q.rationale !== null ? { rationale: q.rationale } : {}),
          ...(q.typeConfig !== null ? { typeConfig: jsonInput(q.typeConfig) } : {}),
          ...(q.extractionConfidence !== null
            ? { extractionConfidence: q.extractionConfidence }
            : {}),
        })),
      });
    }
  }

  // Map original question ids to their copies via the per-version-unique `key`
  // (createMany returns no ids; key is the stable join).
  const newIdByKey = new Map(
    (
      await tx.appQuestionSlot.findMany({
        where: { versionId: targetVersionId },
        select: { id: true, key: true },
      })
    ).map((q) => [q.key, q.id])
  );
  const questionIdMap = new Map<string, string>();
  for (const section of source.sections) {
    for (const q of section.questions) {
      const newId = newIdByKey.get(q.key);
      if (newId) questionIdMap.set(q.id, newId);
    }
  }

  // F2.2: copy the version's tag vocabulary, then re-link each assignment to the copied
  // question + copied tag. Done after the slot loop because re-linking needs the
  // fully-assembled questionIdMap. A copied tag's `normalizedLabel` is unique by
  // construction (carried 1:1 into a fresh version).
  const tagIdMap = new Map<string, string>();
  const newSlotTags: { questionSlotId: string; tagId: string }[] = [];
  for (const tag of source.tags) {
    const newTag = await tx.appQuestionTag.create({
      data: {
        versionId: targetVersionId,
        label: tag.label,
        normalizedLabel: tag.normalizedLabel,
        ...(tag.color !== null ? { color: tag.color } : {}),
      },
      select: { id: true },
    });
    tagIdMap.set(tag.id, newTag.id);
    for (const link of tag.slots) {
      const newSlotId = questionIdMap.get(link.questionSlotId);
      if (newSlotId) newSlotTags.push({ questionSlotId: newSlotId, tagId: newTag.id });
    }
  }
  if (newSlotTags.length > 0) {
    await tx.appQuestionSlotTag.createMany({ data: newSlotTags });
  }

  return { sectionIdMap, questionIdMap, tagIdMap };
}
