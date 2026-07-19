/**
 * Questionnaire version endpoint (P2 / F2.1).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid
 *   Admin-only read of one version's full structural graph — sections (ordered)
 *   each with their ordered questions — plus goal/audience and their stored
 *   per-field provenance (`goalProvenance`/`audienceProvenance`). The version is
 *   scoped to its parent questionnaire, so a mismatched id/vid pair 404s rather
 *   than leaking a version from another questionnaire. 404 when the feature flag
 *   is off. Read model: `_lib/detail.ts`.
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid  (F2.1 / PR2)
 *   Edit the version's goal and/or audience. Forks a new draft first if the target
 *   is launched (the editable id comes back in `meta`). Provenance flips to
 *   `admin-supplied` server-side only for fields whose value actually changed —
 *   an unchanged inferred field keeps its `inferred` provenance.
 *
 * Version-scoped path (`…/versions/:vid/…`) is the convention later F2 work
 * reuses (sections/questions CRUD, F2.4 re-ingest, F5 evaluate).
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateVersionMetaSchema } from '@/lib/app/questionnaire/authoring';
import type {
  AudienceProvenance,
  AudienceShape,
  FieldProvenance,
} from '@/lib/app/questionnaire/types';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  audienceProvenanceForEdit,
  forkMeta,
  goalProvenanceForEdit,
  loadScopedVersion,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

const handleVersionGraph = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const graph = await getVersionGraph(id, vid);
    if (!graph) {
      throw new NotFoundError('Questionnaire version not found');
    }

    log.info('Questionnaire version graph read', {
      questionnaireId: id,
      versionId: vid,
      sectionCount: graph.sections.length,
    });
    return successResponse(graph);
  }
);

/** Fields the version-meta diff + response project (kept identical before/after). */
const VERSION_META_SELECT = {
  id: true,
  versionNumber: true,
  status: true,
  goal: true,
  audience: true,
  goalProvenance: true,
  audienceProvenance: true,
} as const;

const handleVersionMetaPatch = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const body = await validateRequestBody(request, updateVersionMetaSchema);

    // Fork-if-launched preamble: all writes target the editable (possibly new) id.
    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    // Read the pre-edit state first — provenance is resolved against it so only
    // genuinely-changed fields flip to `admin-supplied`.
    const before = await prisma.appQuestionnaireVersion.findUnique({
      where: { id: editId },
      select: VERSION_META_SELECT,
    });

    const data: Prisma.AppQuestionnaireVersionUpdateInput = {};
    if (body.goal !== undefined) {
      data.goal = body.goal;
      data.goalProvenance =
        body.goal === null
          ? null
          : goalProvenanceForEdit(
              body.goal,
              before?.goal ?? null,
              (before?.goalProvenance ?? null) as FieldProvenance | null
            );
    }
    if (body.audience !== undefined) {
      if (body.audience === null) {
        data.audience = Prisma.JsonNull;
        data.audienceProvenance = Prisma.JsonNull;
      } else {
        data.audience = jsonInput(body.audience);
        const provenance = audienceProvenanceForEdit(
          body.audience,
          (before?.audience ?? null) as AudienceShape | null,
          (before?.audienceProvenance ?? null) as AudienceProvenance | null
        );
        data.audienceProvenance =
          Object.keys(provenance).length > 0 ? jsonInput(provenance) : Prisma.JsonNull;
      }
    }

    const updated = await prisma.appQuestionnaireVersion.update({
      where: { id: editId },
      data,
      select: VERSION_META_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_version.update',
      entityType: 'questionnaire_version',
      entityId: editId,
      changes: computeChanges(before ?? {}, updated),
      clientIp,
    });
    log.info('Questionnaire version meta updated', {
      questionnaireId: id,
      versionId: editId,
      forked: fork.forked,
    });

    return successResponse(updated, forkMeta(fork));
  }
);

export const GET = handleVersionGraph;
export const PATCH = handleVersionMetaPatch;
