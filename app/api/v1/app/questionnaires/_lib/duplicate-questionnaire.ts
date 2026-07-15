/**
 * Shared questionnaire-duplication service.
 *
 * Copies a questionnaire's **current** version (launched if present, else the
 * highest-numbered) into a brand-new questionnaire as a fresh `draft` v1 —
 * structure + tags + config + goal/audience + source-doc provenance via the
 * shared {@link copyVersionGraph}. Respondent data (sessions, invitations,
 * evaluation runs, extraction-change records) is deliberately NOT copied: a
 * duplicate starts clean.
 *
 * Two routes orchestrate around this: the general `POST …/:id/duplicate`
 * (plain copy, no attribution) and the DEMO-ONLY `POST …/:id/clone-for-client`
 * (adds demo-client attribution + name suffix). Keeping the create+copy in one
 * place means the two paths can never drift, and a fork that strips the demo
 * clone route leaves the general duplicate fully working.
 *
 * Callers own the HTTP concern: this returns a discriminated result rather than
 * a `Response`, and never logs audit — each route maps the result and records
 * its own audit action.
 */

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';

import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { copyVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/copy-version-graph';
import { MAX_QUESTIONNAIRE_TITLE_LENGTH } from '@/lib/app/questionnaire/title';

export interface DuplicateQuestionnaireInput {
  /** The source questionnaire to copy the current version from. */
  sourceId: string;
  /** Demo client to attribute the copy to; `null` (default) = an unattributed copy. */
  demoClientId?: string | null;
  /** Title suffix appended after an em dash; defaults to "Copy" when omitted/blank. */
  nameSuffix?: string;
}

export type DuplicateQuestionnaireResult =
  | { ok: true; questionnaireId: string; versionId: string; sourceVersionId: string }
  | { ok: false; code: 'SOURCE_NOT_FOUND' | 'NO_VERSION' };

/**
 * Duplicate a questionnaire's current version into a new draft questionnaire.
 * Resolves the source + current version, builds the title, and runs the
 * transactional create+copy. Demo-client validation (404 on unknown client) is
 * the caller's concern — pass an already-validated `demoClientId`.
 */
export async function duplicateQuestionnaire(
  input: DuplicateQuestionnaireInput
): Promise<DuplicateQuestionnaireResult> {
  const { sourceId, demoClientId = null } = input;

  const sourceQuestionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id: sourceId },
    select: { id: true, title: true },
  });
  if (!sourceQuestionnaire) {
    return { ok: false, code: 'SOURCE_NOT_FOUND' };
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
    where: { questionnaireId: sourceId, status: 'launched' },
    orderBy: { versionNumber: 'desc' },
    select: versionSelect,
  });
  const sourceVersion =
    launched ??
    (await prisma.appQuestionnaireVersion.findFirst({
      where: { questionnaireId: sourceId },
      orderBy: { versionNumber: 'desc' },
      select: versionSelect,
    }));
  if (!sourceVersion) {
    return { ok: false, code: 'NO_VERSION' };
  }

  const suffix = input.nameSuffix?.trim() || 'Copy';
  const newTitle = `${sourceQuestionnaire.title} — ${suffix}`.slice(
    0,
    MAX_QUESTIONNAIRE_TITLE_LENGTH
  );

  // Deep-copies the whole version graph (sections, slots, tags, data slots, embeddings) in one
  // transaction; the default 5s interactive-transaction budget is too tight for a large version on a
  // high-latency (serverless → managed Postgres) prod link, so raise it (matches import-definition).
  const result = await executeTransaction(
    async (tx) => {
      const newQuestionnaire = await tx.appQuestionnaire.create({
        data: {
          title: newTitle,
          status: 'draft',
          ...(demoClientId !== null ? { demoClientId } : {}),
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
    },
    { timeout: 20_000 }
  );

  return { ok: true, ...result, sourceVersionId: sourceVersion.id };
}
