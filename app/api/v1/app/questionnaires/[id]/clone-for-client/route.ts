/**
 * Clone-for-client endpoint (DEMO-ONLY — relocated P2.5 clone-for-client; built
 * 2026-06-07 as deferred-gaps audit Item 4, now that its deps F2.2 + F3.1 exist).
 *
 * POST /api/v1/app/questionnaires/:id/clone-for-client
 *   Duplicate the questionnaire's **current** version (launched if present, else the
 *   highest-numbered) into a brand-new questionnaire as a fresh `draft` v1, attributed
 *   to a chosen demo client — so the same questionnaire can be re-used for the next
 *   prospect. Copies structure + tags + config + goal/audience + the source-doc
 *   provenance via the shared `copyVersionGraph`; does NOT copy sessions, invitations,
 *   evaluation runs, or extraction-change records (a clone starts fresh).
 *
 * Pipeline: flag-gate → withAdminAuth → Zod body → source 404 → target-client 404 →
 * transactional create+copy → admin audit → 200 `{ questionnaireId, versionId }`.
 *
 * Auth: admin only. Flag: 404 when `APP_QUESTIONNAIRES_ENABLED` is off. No sub-cap —
 * the 100/min section cap suffices (bounded, no LLM call). A fork strips this file.
 */

import { z } from 'zod';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { copyVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/copy-version-graph';

const QUESTIONNAIRE_TITLE_MAX = 200;

const cloneForClientSchema = z.object({
  /** Demo client to attribute the clone to; `null` = a generic (unattributed) copy. */
  targetDemoClientId: z.string().trim().min(1).nullable(),
  /** Optional title suffix; defaults to the target client's name (or "Copy"). */
  nameSuffix: z.string().trim().max(120).optional(),
});

const handleClone = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const body = await validateRequestBody(request, cloneForClientSchema);

  // Source questionnaire (title) — 404 on unknown / flag-off-invisible.
  const sourceQuestionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!sourceQuestionnaire) {
    return errorResponse('Questionnaire not found', { code: 'NOT_FOUND', status: 404 });
  }

  // Current version = launched if one exists, else the highest-numbered version.
  const versionSelect = {
    id: true,
    goal: true,
    audience: true,
    goalProvenance: true,
    audienceProvenance: true,
  } as const;
  const launched = await prisma.appQuestionnaireVersion.findFirst({
    where: { questionnaireId: id, status: 'launched' },
    orderBy: { versionNumber: 'desc' },
    select: versionSelect,
  });
  const sourceVersion =
    launched ??
    (await prisma.appQuestionnaireVersion.findFirst({
      where: { questionnaireId: id },
      orderBy: { versionNumber: 'desc' },
      select: versionSelect,
    }));
  if (!sourceVersion) {
    return errorResponse('Questionnaire has no version to clone', {
      code: 'NOT_FOUND',
      status: 404,
    });
  }

  // Validate the target client (when attributing) and resolve its name for the default
  // title suffix. A missing client is a 404 (mirrors the attribution PATCH).
  let clientName: string | null = null;
  if (body.targetDemoClientId !== null) {
    const client = await prisma.appDemoClient.findUnique({
      where: { id: body.targetDemoClientId },
      select: { name: true },
    });
    if (!client) {
      return errorResponse('Demo client not found', {
        code: 'DEMO_CLIENT_NOT_FOUND',
        status: 404,
      });
    }
    clientName = client.name;
  }

  const suffix = body.nameSuffix?.trim() || clientName || 'Copy';
  const newTitle = `${sourceQuestionnaire.title} — ${suffix}`.slice(0, QUESTIONNAIRE_TITLE_MAX);

  const result = await executeTransaction(async (tx) => {
    const newQuestionnaire = await tx.appQuestionnaire.create({
      data: {
        title: newTitle,
        status: 'draft',
        ...(body.targetDemoClientId !== null ? { demoClientId: body.targetDemoClientId } : {}),
      },
      select: { id: true },
    });

    const newVersion = await tx.appQuestionnaireVersion.create({
      data: {
        questionnaireId: newQuestionnaire.id,
        versionNumber: 1,
        status: 'draft',
        goal: sourceVersion.goal,
        audience: jsonInput(sourceVersion.audience),
        goalProvenance: sourceVersion.goalProvenance,
        audienceProvenance: jsonInput(sourceVersion.audienceProvenance),
      },
      select: { id: true },
    });

    await copyVersionGraph(tx, sourceVersion.id, newVersion.id);

    // Copy the source's newest source-document row as provenance (the parsed text /
    // file metadata; raw bytes were never persisted). Best-effort — a hand-built
    // questionnaire may have none.
    const srcDoc = await tx.appQuestionnaireSourceDocument.findFirst({
      where: { versionId: sourceVersion.id },
      orderBy: { createdAt: 'desc' },
      select: {
        fileName: true,
        fileHash: true,
        byteSize: true,
        mimeType: true,
        pageCount: true,
        warnings: true,
        extractedText: true,
      },
    });
    if (srcDoc) {
      await tx.appQuestionnaireSourceDocument.create({
        data: { versionId: newVersion.id, ...srcDoc, warnings: jsonInput(srcDoc.warnings) },
      });
    }

    return { questionnaireId: newQuestionnaire.id, versionId: newVersion.id };
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire.clone_for_client',
    entityType: 'questionnaire',
    entityId: result.questionnaireId,
    metadata: {
      sourceQuestionnaireId: id,
      sourceVersionId: sourceVersion.id,
      targetDemoClientId: body.targetDemoClientId,
      newVersionId: result.versionId,
    },
    clientIp,
  });
  log.info('Questionnaire cloned for client', {
    sourceQuestionnaireId: id,
    newQuestionnaireId: result.questionnaireId,
    targetDemoClientId: body.targetDemoClientId,
  });

  return successResponse(result, undefined, { status: 201 });
});

export const POST = withQuestionnairesEnabled(handleClone);
