/**
 * Server pipeline for the Structure Edit Agent (precise mode).
 *
 * `loadEditableStructure` is the precise-mode sibling of `loadRefinableStructure`: it loads the
 * version's structure (scoped to its questionnaire) as a richer {@link EditableStructure} carrying
 * entity ids, `required`/`weight`, and ordinals — everything the deterministic executor needs to
 * compute a before→after preview and to apply granular updates that preserve untouched fields.
 *
 * It deliberately does NOT block launched or session-pinned versions: the apply route forks a fresh
 * draft first (via `forkVersionIfLaunched`) when the version is launched or has real respondent
 * sessions, then loads the fork here — so in-flight work stays pinned to the version it started on
 * while the edit lands on a new draft. The plan (preview) route just reads; it never writes.
 *
 * `applyResolvedChanges` writes a `ResolvedChange[]` in one transaction via per-entity updates. It
 * deliberately does NOT go through `replaceVersionStructure` (which rewrites the whole graph and
 * resets weight→0.5 / required→optional) — the whole point of precise mode is surgical edits.
 */

import { errorResponse } from '@/lib/api/responses';
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';
import type { ResolvedChange } from '@/lib/app/questionnaire/edit-agent/types';

type PipelineResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Load a version's structure as an {@link EditableStructure}, scoped to its questionnaire. Returns
 * the structure or a ready-made 404 `Response`. Launched / session-pinned versions are handled by
 * the caller's fork step, not blocked here (see the module doc).
 */
export async function loadEditableStructure(
  questionnaireId: string,
  versionId: string
): Promise<PipelineResult<EditableStructure>> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      questionnaireId: true,
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
              key: true,
              ordinal: true,
              prompt: true,
              type: true,
              required: true,
              weight: true,
            },
          },
        },
      },
    },
  });

  if (!version || version.questionnaireId !== questionnaireId) {
    return {
      ok: false,
      response: errorResponse('Questionnaire version not found', {
        code: 'NOT_FOUND',
        status: 404,
      }),
    };
  }

  const structure: EditableStructure = {
    versionId,
    sections: version.sections.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      title: s.title,
      description: s.description,
      questions: s.questions.map((q) => ({
        id: q.id,
        key: q.key,
        ordinal: q.ordinal,
        prompt: q.prompt,
        type: q.type as QuestionType,
        required: q.required,
        weight: q.weight,
      })),
    })),
  };

  return { ok: true, value: structure };
}

/** Counts written by {@link applyResolvedChanges} (for the audit log + response). */
export interface ApplyCounts {
  changeCount: number;
  sectionCount: number;
  questionCount: number;
}

/**
 * Apply a resolved change list to an existing version in one transaction. Each change is a single
 * per-entity field update mirroring the granular authoring routes; untouched fields are never read
 * or written, so weights/required flags the instruction didn't name are preserved.
 */
export async function applyResolvedChanges(changes: ResolvedChange[]): Promise<ApplyCounts> {
  const sectionsTouched = new Set<string>();
  const questionsTouched = new Set<string>();

  await executeTransaction(async (tx) => {
    for (const change of changes) {
      switch (change.field) {
        case 'section.title':
          await tx.appQuestionnaireSection.update({
            where: { id: change.entityId },
            data: { title: change.value as string },
          });
          sectionsTouched.add(change.entityId);
          break;
        case 'section.ordinal':
          await tx.appQuestionnaireSection.update({
            where: { id: change.entityId },
            data: { ordinal: change.value as number },
          });
          sectionsTouched.add(change.entityId);
          break;
        case 'question.prompt':
          await tx.appQuestionSlot.update({
            where: { id: change.entityId },
            data: { prompt: change.value as string },
          });
          questionsTouched.add(change.entityId);
          break;
        case 'question.required':
          await tx.appQuestionSlot.update({
            where: { id: change.entityId },
            data: { required: change.value as boolean },
          });
          questionsTouched.add(change.entityId);
          break;
        case 'question.weight':
          await tx.appQuestionSlot.update({
            where: { id: change.entityId },
            data: { weight: change.value as number },
          });
          questionsTouched.add(change.entityId);
          break;
        case 'question.ordinal':
          await tx.appQuestionSlot.update({
            where: { id: change.entityId },
            data: { ordinal: change.value as number },
          });
          questionsTouched.add(change.entityId);
          break;
        case 'question.section':
          await tx.appQuestionSlot.update({
            where: { id: change.entityId },
            data: { sectionId: change.toSectionId, ordinal: change.value as number },
          });
          questionsTouched.add(change.entityId);
          break;
      }
    }
  });

  return {
    changeCount: changes.length,
    sectionCount: sectionsTouched.size,
    questionCount: questionsTouched.size,
  };
}
