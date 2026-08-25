/**
 * Topic seeding at the DB seam (P17).
 *
 * Wraps the pure `planSeededTopics` with the reads and the write. Called from the ingest
 * transaction and from the structure-replace path, so any route that lays down a fresh section
 * graph gets a matching topic set without knowing this feature exists.
 *
 * **Additive only.** Existing topics are never modified or deleted — the seeder adds topics for
 * sections that have none. An admin who has hand-authored their topics can re-ingest without losing
 * that work, which is the whole reason this is not a "delete and rebuild".
 */

import { logger } from '@/lib/logging';
import { executeTransaction } from '@/lib/db/utils';
import { planDataSlotAttachment, planSeededTopics } from '@/lib/app/questionnaire/scope/seed';
import { narrowTopicMembers } from '@/lib/app/questionnaire/scope/types';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

/** The interactive-transaction client, matching `persist.ts`'s `IngestTx`. */
type Tx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/**
 * Seed one `core` topic per section that is not already covered by a topic.
 *
 * Returns how many topics were created. Never throws on an empty version — a questionnaire with no
 * sections simply seeds nothing.
 */
export async function seedTopicsForVersion(tx: Tx, versionId: string): Promise<number> {
  const [sections, questions, dataSlots, existing] = await Promise.all([
    tx.appQuestionnaireSection.findMany({
      where: { versionId },
      select: { id: true, title: true, ordinal: true },
      orderBy: { ordinal: 'asc' },
    }),
    tx.appQuestionSlot.findMany({
      where: { versionId },
      select: { key: true, sectionId: true },
      orderBy: { ordinal: 'asc' },
    }),
    tx.appDataSlot.findMany({
      where: { versionId },
      select: {
        key: true,
        questions: { select: { questionSlot: { select: { key: true } } } },
      },
      orderBy: { ordinal: 'asc' },
    }),
    tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      select: { key: true, members: true },
    }),
  ]);

  if (sections.length === 0) return 0;

  // A section is "already covered" when some existing topic claims any of its questions. Checking
  // membership rather than section identity is deliberate: topics do not point at sections, and an
  // admin who split one section across two topics has covered it just as thoroughly.
  const claimed = new Set<string>();
  for (const topic of existing) {
    for (const key of narrowTopicMembers(topic.members).questionKeys) claimed.add(key);
  }
  const uncoveredSectionIds = new Set(
    sections
      .filter((s) => {
        const own = questions.filter((q) => q.sectionId === s.id);
        return own.length > 0 && own.every((q) => !claimed.has(q.key));
      })
      .map((s) => s.id)
  );
  if (uncoveredSectionIds.size === 0) return 0;

  const planned = planSeededTopics({
    sections: sections.filter((s) => uncoveredSectionIds.has(s.id)),
    questions: questions.filter((q) => uncoveredSectionIds.has(q.sectionId)),
    dataSlots: dataSlots.map((d) => ({
      key: d.key,
      mappedQuestionKeys: d.questions.map((q) => q.questionSlot.key),
    })),
    existingKeys: new Set(existing.map((t) => t.key)),
  });
  if (planned.length === 0) return 0;

  // Append after any existing topics so hand-authored ordering is preserved.
  const ordinalBase = existing.length;
  await tx.appQuestionnaireTopic.createMany({
    data: planned.map((t, i) => ({
      versionId,
      key: t.key,
      label: t.label,
      phase: t.phase,
      depth: 'full',
      members: jsonInput(t.members),
      ordinal: ordinalBase + i,
      source: t.source,
    })),
  });

  return planned.length;
}

/**
 * Attach every unclaimed data slot to the topic that owns most of its questions.
 *
 * The fix for an ordering problem that would otherwise be permanent. Topics are seeded during
 * INGEST, and ingest creates no data slots — those are generated afterwards, by a separate admin
 * step. So every seeded topic is born with `dataSlotKeys: []`, and nothing else ever revisits
 * membership: not a later structure-replace (whose seeder skips sections that are already covered),
 * not the data-slot generator, not the authoring routes. The slot set and the topic set would simply
 * never meet.
 *
 * Calling this wherever data slots are written is what makes the authoring order stop mattering.
 *
 * **Additive, idempotent, and never a move** — see `planDataSlotAttachment`. Only topics that gain
 * something are written, so the common case (nothing to do) costs two reads and no writes.
 *
 * Returns how many topics were updated, for the caller's logging.
 */
export async function attachDataSlotsForVersion(tx: Tx, versionId: string): Promise<number> {
  const [topics, dataSlots] = await Promise.all([
    tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      select: { id: true, key: true, ordinal: true, members: true },
      orderBy: { ordinal: 'asc' },
    }),
    tx.appDataSlot.findMany({
      where: { versionId },
      select: {
        key: true,
        questions: { select: { questionSlot: { select: { key: true } } } },
      },
      orderBy: { ordinal: 'asc' },
    }),
  ]);
  if (topics.length === 0 || dataSlots.length === 0) return 0;

  const narrowed = topics.map((t) => ({ ...t, members: narrowTopicMembers(t.members) }));
  const additions = planDataSlotAttachment({
    topics: narrowed.map((t) => ({ key: t.key, ordinal: t.ordinal, members: t.members })),
    dataSlots: dataSlots.map((d) => ({
      key: d.key,
      mappedQuestionKeys: d.questions.map((q) => q.questionSlot.key),
    })),
  });
  if (additions.size === 0) return 0;

  for (const topic of narrowed) {
    const add = additions.get(topic.key);
    if (!add || add.length === 0) continue;
    await tx.appQuestionnaireTopic.update({
      where: { id: topic.id },
      data: {
        members: jsonInput({
          questionKeys: topic.members.questionKeys,
          dataSlotKeys: [...topic.members.dataSlotKeys, ...add],
        }),
      },
    });
  }

  return additions.size;
}

/**
 * Reconcile topics against a graph that has just been REWRITTEN (structure replace, re-ingest).
 *
 * A rewrite deletes the section/slot graph and lays down new rows with new keys, so a topic's
 * membership can be left pointing at questions that no longer exist. Three steps, in order:
 *
 *  1. **Prune** each topic's membership to keys that still exist.
 *  2. **Delete** topics left with nothing — the structure they described is gone, and a topic that
 *     can never contribute a question is a trap on the authoring surface.
 *  3. **Seed** any section the survivors do not cover.
 *
 * Deliberately not "delete all and re-seed": an admin's phases, criteria and hard-won wording are
 * the expensive part of authoring, and a topic whose questions survived a rewrite should survive it
 * too. The cost is that a heavily-rewritten questionnaire keeps some topics with thinned membership
 * — visible and fixable on the Topics surface, which is far better than silently discarding prose.
 */
export async function reconcileTopicsForVersion(tx: Tx, versionId: string): Promise<void> {
  const [topics, questions, dataSlots] = await Promise.all([
    tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      select: { id: true, members: true },
    }),
    tx.appQuestionSlot.findMany({ where: { versionId }, select: { key: true } }),
    tx.appDataSlot.findMany({ where: { versionId }, select: { key: true } }),
  ]);

  if (topics.length > 0) {
    const liveQuestionKeys = new Set(questions.map((q) => q.key));
    const liveDataSlotKeys = new Set(dataSlots.map((d) => d.key));
    const emptied: string[] = [];

    for (const topic of topics) {
      const members = narrowTopicMembers(topic.members);
      const questionKeys = members.questionKeys.filter((k) => liveQuestionKeys.has(k));
      const dataSlotKeys = members.dataSlotKeys.filter((k) => liveDataSlotKeys.has(k));

      if (questionKeys.length === 0 && dataSlotKeys.length === 0) {
        emptied.push(topic.id);
        continue;
      }
      if (
        questionKeys.length === members.questionKeys.length &&
        dataSlotKeys.length === members.dataSlotKeys.length
      ) {
        continue; // untouched by the rewrite
      }
      await tx.appQuestionnaireTopic.update({
        where: { id: topic.id },
        data: { members: jsonInput({ questionKeys, dataSlotKeys }) },
      });
    }

    if (emptied.length > 0) {
      await tx.appQuestionnaireTopic.deleteMany({ where: { id: { in: emptied } } });
      logger.info('conditional topics: dropped topics emptied by a structure rewrite', {
        versionId,
        count: emptied.length,
      });
    }
  }

  await seedTopicsForVersion(tx, versionId);
  // After the seed, because a topic created moments ago is as entitled to its data slots as one
  // that survived the rewrite.
  await attachDataSlotsForVersion(tx, versionId);
}

/**
 * Seed topics outside a caller's transaction, swallowing failure.
 *
 * For callers where seeding is a nicety rather than part of the write's meaning — a version whose
 * structure was just replaced still has a valid structure if the topic seed fails, and turning that
 * into a failed save would be a poor trade. Ingest uses the in-transaction form instead, because a
 * half-seeded fresh version is worth rolling back.
 */
export async function seedTopicsBestEffort(versionId: string): Promise<void> {
  try {
    const count = await executeTransaction(async (tx) => seedTopicsForVersion(tx, versionId));
    if (count > 0) logger.info('conditional topics: seeded topics', { versionId, count });
  } catch (err) {
    logger.error('conditional topics: topic seeding failed', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
