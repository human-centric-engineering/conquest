/**
 * Deterministic scoring schema — read + author (report kind `cohort`, F14.4).
 *
 * GET  /api/v1/app/questionnaires/:id/versions/:vid/scoring-schema
 *   Admin-only. Returns the version's scoring schema (or an empty one) plus the available question /
 *   data-slot keys the builder maps onto scales.
 * PUT  …/scoring-schema   body: { name?, content: ScoringSchemaContent }
 *   Admin-only. Validates + saves the schema (the visual-builder path; the upload path's extract
 *   route returns a proposal the admin saves through here). Forks a new draft first if the target is
 *   launched, then recomputes the version's respondent scores (best-effort). Gated by the
 *   cohort-report flag.
 *
 * The schema is versioned (1:1 with a version) and forks with the version on launch, like config.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { z } from 'zod';

import {
  scoringSchemaContentSchema,
  narrowScoringSchemaContent,
  recomputeSessionScores,
} from '@/lib/app/questionnaire/scoring';
import { EMPTY_SCORING_SCHEMA } from '@/lib/app/questionnaire/scoring/types';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

type Params = { id: string; vid: string };

/** Assemble the read shape: the schema content + the keys the builder maps onto scales. */
async function buildSchemaView(versionId: string) {
  const [schema, slots, dataSlots] = await Promise.all([
    prisma.appScoringSchema.findUnique({
      where: { versionId },
      select: { name: true, content: true, source: true },
    }),
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
      select: { key: true, prompt: true, type: true },
    }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: { key: true, name: true },
    }),
  ]);
  return {
    versionId,
    name: schema?.name ?? 'Scoring',
    source: schema?.source ?? 'manual',
    content: schema ? narrowScoringSchemaContent(schema.content) : EMPTY_SCORING_SCHEMA,
    questions: slots.map((s) => ({ key: s.key, prompt: s.prompt, type: s.type })),
    dataSlots: dataSlots.map((d) => ({ key: d.key, name: d.name })),
  };
}

const handleGet = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id, vid } = await params;
  const scoped = await loadScopedVersion(id, vid);
  if (!scoped) throw new NotFoundError('Questionnaire version not found');
  return successResponse(await buildSchemaView(vid));
});

const putSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  content: scoringSchemaContentSchema,
});

const handlePut = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped) throw new NotFoundError('Questionnaire version not found');

  const body = await validateRequestBody(request, putSchema);

  // Fork-if-launched: all writes target the editable (possibly new) version id.
  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;

  const saved = await prisma.appScoringSchema.upsert({
    where: { versionId: editId },
    create: {
      versionId: editId,
      name: body.name ?? 'Scoring',
      content: jsonInput(body.content),
      source: 'manual',
      createdBy: session.user.id,
    },
    update: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      content: jsonInput(body.content),
    },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_scoring_schema.update',
    entityType: 'app_scoring_schema',
    entityId: saved.id,
    metadata: { versionId: editId, scales: body.content.scales.length },
    clientIp,
  });

  // Recompute respondent scores for this version's non-preview sessions (best-effort).
  try {
    const sessions = await prisma.appQuestionnaireSession.findMany({
      where: { versionId: editId, isPreview: false },
      select: { id: true },
    });
    await recomputeSessionScores({
      versionId: editId,
      schemaId: saved.id,
      schema: body.content,
      sessionIds: sessions.map((s) => s.id),
    });
  } catch (err) {
    logger.warn('scoring schema: recompute after save failed', {
      versionId: editId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Scoring schema saved', { questionnaireId: id, versionId: editId, forked: fork.forked });
  return successResponse({ ...(await buildSchemaView(editId)), ...forkMeta(fork) });
});

export const GET = handleGet;
// PATCH (not PUT): the editor always sends the full schema, but the platform apiClient exposes
// patch/post/get/delete — PATCH keeps the client call idiomatic for a whole-resource save.
export const PATCH = handlePut;
