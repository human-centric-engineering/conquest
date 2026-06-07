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
import { copyVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/copy-version-graph';
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
    // Goal/audience live on the version row (copied here); the structural graph copy
    // is single-sourced with clone-for-client via copyVersionGraph.
    const source = await tx.appQuestionnaireVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: {
        goal: true,
        audience: true,
        goalProvenance: true,
        audienceProvenance: true,
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

    const { sectionIdMap, questionIdMap, tagIdMap } = await copyVersionGraph(
      tx,
      versionId,
      newVersion.id
    );

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
