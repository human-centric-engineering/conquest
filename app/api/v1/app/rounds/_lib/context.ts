/**
 * Round Additional Context ("interviewer briefing") — admin read model + validation helpers.
 *
 * Serializes `AppRoundContextEntry` rows for the admin UI, denormalising each attributed entry's
 * question prompt (so the panel can label "attached to: …") in a FIXED query budget — one entries
 * query + one prompts sweep, no per-row N+1. Route-local DB seam (the `lib/app/**` boundary is
 * Prisma-free). The runtime injection read is the separate, leaner `questionnaire-sessions/_lib/
 * round-briefing.ts`.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { ROUND_CONTEXT_SOURCES } from '@/lib/app/questionnaire/rounds/schemas';
import { resolveItemVersions } from '@/app/api/v1/app/rounds/_lib/versions';
import type {
  BriefableQuestionnaire,
  BriefableQuestion,
  RoundContextEntryView,
} from '@/lib/app/questionnaire/rounds/types';

const ENTRY_SELECT = {
  id: true,
  roundId: true,
  versionId: true,
  questionSlotId: true,
  title: true,
  content: true,
  source: true,
  ordinal: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AppRoundContextEntrySelect;

type EntryRow = Prisma.AppRoundContextEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

function toEntryView(row: EntryRow, questionPrompt: string | null): RoundContextEntryView {
  return {
    id: row.id,
    roundId: row.roundId,
    versionId: row.versionId,
    questionSlotId: row.questionSlotId,
    questionPrompt,
    title: row.title,
    content: row.content,
    source: narrowToEnum(row.source, ROUND_CONTEXT_SOURCES, 'manual'),
    ordinal: row.ordinal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Resolve the attributed-question prompts for a batch of entries in one query (id → prompt). */
async function questionPrompts(slotIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (slotIds.length === 0) return map;
  const rows = await prisma.appQuestionSlot.findMany({
    where: { id: { in: slotIds } },
    select: { id: true, prompt: true },
  });
  for (const r of rows) map.set(r.id, r.prompt);
  return map;
}

/**
 * A round's briefing entries (optionally narrowed to one `versionId`), author-ordered, each enriched
 * with its attributed question prompt (null for general entries, or when the question no longer
 * exists after a version fork — surfaced so the admin can spot + re-attach the orphan).
 */
export async function listRoundContextEntries(
  roundId: string,
  versionId?: string
): Promise<RoundContextEntryView[]> {
  const rows = await prisma.appRoundContextEntry.findMany({
    where: { roundId, ...(versionId ? { versionId } : {}) },
    orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    select: ENTRY_SELECT,
  });
  if (rows.length === 0) return [];

  const slotIds = [...new Set(rows.map((r) => r.questionSlotId).filter((x): x is string => !!x))];
  const prompts = await questionPrompts(slotIds);
  return rows.map((r) =>
    toEntryView(r, r.questionSlotId ? (prompts.get(r.questionSlotId) ?? null) : null)
  );
}

/** One entry by id within a round, or null when unknown. Enriched like the list rows. */
export async function getRoundContextEntry(
  roundId: string,
  entryId: string
): Promise<RoundContextEntryView | null> {
  const row = await prisma.appRoundContextEntry.findFirst({
    where: { id: entryId, roundId },
    select: ENTRY_SELECT,
  });
  if (!row) return null;
  const prompt = row.questionSlotId
    ? ((await questionPrompts([row.questionSlotId])).get(row.questionSlotId) ?? null)
    : null;
  return toEntryView(row, prompt);
}

/**
 * Validate that `versionId` is one the round actually bundles (a `roundItem`), so a briefing can't be
 * authored against a version outside the round. Returns the version id when valid, else null.
 */
export async function assertRoundBundlesVersion(
  roundId: string,
  versionId: string
): Promise<boolean> {
  // A round item either pins this exact version, or pins the questionnaire whose version this is.
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { questionnaireId: true },
  });
  if (!version) return false;
  const item = await prisma.appQuestionnaireRoundItem.findFirst({
    where: {
      roundId,
      OR: [{ versionId }, { questionnaireId: version.questionnaireId }],
    },
    select: { id: true },
  });
  return item !== null;
}

/**
 * Validate that `questionSlotId` belongs to `versionId` — so an attributed entry always points at a
 * question that exists in the briefed version. Returns true when the slot is in the version.
 */
export async function assertSlotInVersion(
  versionId: string,
  questionSlotId: string
): Promise<boolean> {
  const slot = await prisma.appQuestionSlot.findFirst({
    where: { id: questionSlotId, versionId },
    select: { id: true },
  });
  return slot !== null;
}

/**
 * A single version's goal + briefable questions — the input the suggest capability evaluates. One
 * version read + one question sweep. Returns null when the version is unknown.
 */
export async function loadVersionForSuggest(
  versionId: string
): Promise<{ goal: string | null; questions: BriefableQuestion[] } | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { goal: true },
  });
  if (!version) return null;
  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
    select: { id: true, prompt: true, section: { select: { title: true } } },
  });
  return {
    goal: version.goal,
    questions: slots.map((s) => ({ id: s.id, prompt: s.prompt, sectionTitle: s.section.title })),
  };
}

/**
 * The round's bundled questionnaires with their briefable questions — the source for the admin
 * attribution picker. Each questionnaire resolves to one effective version (pinned or current
 * launched); its question slots are listed in section → ordinal order. Questionnaires with no
 * resolvable version are omitted (nothing to attribute to yet). Fixed query budget: one items read,
 * one launched-version sweep, one question sweep.
 */
export async function listBriefableQuestionnaires(
  roundId: string
): Promise<BriefableQuestionnaire[]> {
  const items = await prisma.appQuestionnaireRoundItem.findMany({
    where: { roundId },
    orderBy: { createdAt: 'asc' },
    select: {
      questionnaireId: true,
      versionId: true,
      questionnaire: { select: { title: true } },
    },
  });
  if (items.length === 0) return [];

  const resolved = await resolveItemVersions(items);
  const versionIds = [...new Set([...resolved.values()].filter((v): v is string => !!v))];
  if (versionIds.length === 0) return [];

  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId: { in: versionIds } },
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
    select: {
      id: true,
      prompt: true,
      versionId: true,
      section: { select: { title: true } },
    },
  });
  const byVersion = new Map<string, BriefableQuestion[]>();
  for (const s of slots) {
    const list = byVersion.get(s.versionId) ?? [];
    list.push({ id: s.id, prompt: s.prompt, sectionTitle: s.section.title });
    byVersion.set(s.versionId, list);
  }

  return items
    .map((it): BriefableQuestionnaire | null => {
      const versionId = resolved.get(it.questionnaireId);
      if (!versionId) return null;
      return {
        questionnaireId: it.questionnaireId,
        title: it.questionnaire.title,
        versionId,
        questions: byVersion.get(versionId) ?? [],
      };
    })
    .filter((q): q is BriefableQuestionnaire => q !== null);
}
