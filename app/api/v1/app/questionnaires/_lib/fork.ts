/**
 * Version-fork writer for structural authoring (F2.1 / PR2).
 *
 * Editing a *launched* version must not mutate it in place — in-flight work stays
 * pinned to the version it started on. So every authoring mutation calls
 * {@link forkVersionIfLaunched} as a preamble: if the target version is launched
 * (or, from P3/P4, has live sessions/invitations), it deep-copies the version's
 * goal/audience + section→question graph into a fresh `draft` and returns the new
 * id; otherwise it returns the original id untouched. The route then writes to the
 * returned `versionId`.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` module stays Prisma-free;
 * the pure predicate (`hasLaunchBlockers`) lives there, while the DB-touching count
 * (`countLaunchBlockers`, real for invitations as of F3.2) and this deep copy live
 * route-local, mirroring `_lib/persist.ts`.
 *
 * Copied into the fork: goal/audience + provenance, the section→question graph,
 * (F2.2) the tag vocabulary with its question assignments re-linked to the copies,
 * and (F3.1) the run-time config row when one exists (so the draft launches with
 * the same settings; the config is 1:1 with the version, not a child addressed by URL).
 *
 * Deliberately NOT copied into the fork:
 *   - `AppQuestionnaireExtractionChange` records — a fork starts a clean editorial
 *     lineage; the original keeps its ingest log.
 */

import { executeTransaction } from '@/lib/db/utils';
import {
  countLaunchBlockers,
  hasLaunchBlockers,
} from '@/app/api/v1/app/questionnaires/_lib/launch-blockers';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import {
  jsonInput,
  type ScopedVersion,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

/** The version a mutation should write to, and whether a fork happened. */
export interface ForkResult {
  /** The editable version id — a new draft when `forked`, else the original. */
  versionId: string;
  forked: boolean;
  /** The editable version's number (the new draft's, or the original's). */
  versionNumber: number;
  /**
   * Old→new id maps, present only when `forked`. A child mutation (edit/delete a
   * section or question of a launched version) targets the *original* id in its
   * URL; after the fork it must retarget the copied entity. `resolveForkedId`
   * (authoring-routes) does the lookup. Empty/undefined on the no-fork path, where
   * the original id is already the editable one.
   */
  sectionIdMap?: Map<string, string>;
  questionIdMap?: Map<string, string>;
  /**
   * Old→new tag id map, present only when `forked`. The replace-set tag-assignment
   * route (`PUT …/questions/:id/tags`) receives client-sent tag ids that name the
   * *original* version's tags; after a fork it retargets them through this map.
   */
  tagIdMap?: Map<string, string>;
}

/** Audit attribution carried from the route (admin user + client IP). */
export interface ForkAuditContext {
  userId: string | null;
  clientIp?: string | null;
}

/**
 * Fork the version into a new draft if it is launched (or pinned by a blocker);
 * otherwise return it unchanged. Takes the already-loaded {@link ScopedVersion}
 * from the route's `loadScopedVersion` — no second read of the same row.
 */
export async function forkVersionIfLaunched(
  scoped: ScopedVersion,
  audit?: ForkAuditContext
): Promise<ForkResult> {
  const { id: versionId, questionnaireId } = scoped;

  const blockers = await countLaunchBlockers(versionId);
  const shouldFork = scoped.status === 'launched' || hasLaunchBlockers(blockers);
  if (!shouldFork) {
    return { versionId, forked: false, versionNumber: scoped.versionNumber };
  }

  const created = await executeTransaction(async (tx) => {
    const source = await tx.appQuestionnaireVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: {
        goal: true,
        audience: true,
        goalProvenance: true,
        audienceProvenance: true,
        // Reuse the read view's column set so a new config column is copied by the
        // fork automatically — no separate list here to fall out of sync (F3.1).
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

    // Next version number for this questionnaire (the version-service pattern).
    // `@@unique([questionnaireId, versionNumber])` guards against a race.
    const last = await tx.appQuestionnaireVersion.findFirst({
      where: { questionnaireId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const versionNumber = (last?.versionNumber ?? 0) + 1;

    const newVersion = await tx.appQuestionnaireVersion.create({
      data: {
        questionnaireId,
        versionNumber,
        status: 'draft',
        goal: source.goal,
        audience: jsonInput(source.audience),
        goalProvenance: source.goalProvenance,
        audienceProvenance: jsonInput(source.audienceProvenance),
      },
      select: { id: true },
    });

    // F3.1: copy the run-time config row into the fork when one exists (1:1 with
    // the version). A no-config source forks to a no-config draft — both resolve
    // to the same defaults on read.
    if (source.config) {
      await tx.appQuestionnaireConfig.create({
        data: {
          versionId: newVersion.id,
          // Spread the selected columns (CONFIG_SELECT) verbatim; only the JSON
          // column needs the null-sentinel wrapper. New columns ride along.
          ...source.config,
          profileFields: jsonInput(source.config.profileFields),
        },
      });
    }

    // Sections first (slots reference them); copy ordinal verbatim, mapping each
    // original section id to its copy so child mutations can retarget after a fork.
    const sectionIdMap = new Map<string, string>();
    for (const section of source.sections) {
      const newSection = await tx.appQuestionnaireSection.create({
        data: {
          versionId: newVersion.id,
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
            versionId: newVersion.id,
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
          where: { versionId: newVersion.id },
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

    // F2.2: copy the version's tag vocabulary into the fork, then re-link each
    // assignment to the copied question + copied tag. Done here (not in the
    // per-section loop) because tags are version-scoped and re-linking needs the
    // fully-assembled questionIdMap. A copied tag's `normalizedLabel` is unique by
    // construction (carried 1:1 into a fresh version).
    const tagIdMap = new Map<string, string>();
    const newSlotTags: { questionSlotId: string; tagId: string }[] = [];
    for (const tag of source.tags) {
      const newTag = await tx.appQuestionTag.create({
        data: {
          versionId: newVersion.id,
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

    return { id: newVersion.id, versionNumber, sectionIdMap, questionIdMap, tagIdMap };
  });

  // Audit outside the transaction (fire-and-forget), once per fork.
  logAdminAction({
    userId: audit?.userId ?? null,
    action: 'questionnaire_version.fork',
    entityType: 'questionnaire_version',
    entityId: created.id,
    metadata: { questionnaireId, sourceVersionId: versionId, versionNumber: created.versionNumber },
    clientIp: audit?.clientIp ?? null,
  });

  return {
    versionId: created.id,
    forked: true,
    versionNumber: created.versionNumber,
    sectionIdMap: created.sectionIdMap,
    questionIdMap: created.questionIdMap,
    tagIdMap: created.tagIdMap,
  };
}
