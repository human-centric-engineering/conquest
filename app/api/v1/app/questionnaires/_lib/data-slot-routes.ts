/**
 * Route-local DB seam for the data-slots feature (the `lib/app/questionnaire/data-slots/**`
 * module stays Prisma-free). Loads the version's data slots into the client-safe
 * {@link DataSlotView}, builds the generator's input structure, and replaces the version's
 * data-slot set on a bulk save. Used by the generate + CRUD routes.
 */

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
import type { DataSlotView, DataSlotStructureInput } from '@/lib/app/questionnaire/data-slots';

/** Shared select projecting a data slot + its mapped question keys. */
export const DATA_SLOT_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  theme: true,
  ordinal: true,
  weight: true,
  questions: { select: { questionSlot: { select: { key: true } } } },
} as const;

type DataSlotRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  theme: string;
  ordinal: number;
  weight: number;
  questions: { questionSlot: { key: string } }[];
};

/** Project a `DATA_SLOT_SELECT` row to the client-safe view. */
export function toDataSlotView(row: DataSlotRow): DataSlotView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    theme: row.theme,
    ordinal: row.ordinal,
    weight: row.weight,
    questionKeys: row.questions.map((q) => q.questionSlot.key),
  };
}

/** All data slots for a version, ordinal order. */
export async function loadDataSlots(versionId: string): Promise<DataSlotView[]> {
  const rows = await prisma.appDataSlot.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: DATA_SLOT_SELECT,
  });
  return rows.map(toDataSlotView);
}

/** Count of data slots for a version (the launch gate reads this). */
export async function countDataSlots(versionId: string): Promise<number> {
  return prisma.appDataSlot.count({ where: { versionId } });
}

/**
 * Build the generator's input structure for one version, scoped to its parent questionnaire
 * (a mismatched pair returns `null` → 404). One entry per question with key/prompt/type/section.
 */
export async function buildDataSlotStructure(
  questionnaireId: string,
  versionId: string
): Promise<DataSlotStructureInput | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      goal: true,
      audience: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          title: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: { key: true, prompt: true, type: true },
          },
        },
      },
    },
  });
  if (!version) return null;

  const questions = version.sections.flatMap((section) =>
    section.questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      type: q.type,
      sectionTitle: section.title,
    }))
  );
  if (questions.length === 0) return null;

  return {
    goal: version.goal,
    audience: version.audience ?? undefined,
    questions,
  };
}

/** One slot to persist on a bulk save (already validated by `saveDataSlotsSchema`). */
export interface DataSlotInput {
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
  weight?: number;
}

/**
 * Replace a version's entire data-slot set with `slots` (the admin's reviewed/accepted set),
 * inside a transaction: delete existing slots (mappings cascade), then create each slot with a
 * derived unique `key` and its question mappings (only keys that exist in the version are
 * linked). Returns the persisted views.
 */
export async function replaceDataSlots(
  versionId: string,
  slots: DataSlotInput[]
): Promise<DataSlotView[]> {
  // Resolve which question keys exist in this version (ignore stale/unknown keys).
  const versionQuestions = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    select: { id: true, key: true },
  });
  const idByKey = new Map(versionQuestions.map((q) => [q.key, q.id]));

  await executeTransaction(async (tx) => {
    await tx.appDataSlot.deleteMany({ where: { versionId } });

    const takenKeys = new Set<string>();
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      const key = nextAvailableKey(slugifyKey(slot.name), takenKeys);
      takenKeys.add(key);

      const created = await tx.appDataSlot.create({
        data: {
          versionId,
          key,
          name: slot.name,
          description: slot.description,
          theme: slot.theme,
          ordinal: i,
          ...(slot.weight !== undefined ? { weight: slot.weight } : {}),
        },
        select: { id: true },
      });

      const mappings = [...new Set(slot.questionKeys)]
        .map((qk) => idByKey.get(qk))
        .filter((id): id is string => id !== undefined)
        .map((questionSlotId) => ({ dataSlotId: created.id, questionSlotId }));
      if (mappings.length > 0) {
        await tx.appDataSlotQuestion.createMany({ data: mappings });
      }
    }
  });

  return loadDataSlots(versionId);
}
