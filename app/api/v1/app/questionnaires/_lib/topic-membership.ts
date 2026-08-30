/**
 * Keeping topic membership true as questions come and go (Conditional Topics, F17.35).
 *
 * `AppQuestionnaireTopic.members` was written at ingest and by the Topics tab, and by nothing else.
 * Every other way a question comes into existence — an admin adding one, a judge's `add_question`
 * or `split_question` being applied, extraction review restoring one — created a question no topic
 * claimed. With Conditional Topics on, `isQuestionInScope` is
 * `!scope.active || scope.questionKeys.has(key)`, so such a question is **never asked**, and
 * `scope/types.ts` records that as the failure that matters: it "can never be asked, and nothing
 * else in the system would ever tell you".
 *
 * Deletion is the more dangerous half. A stale key is not a crash — `resolveScope` skips one that
 * resolves to no question — but `empty_topic` counts RAW member keys, so a conditional topic whose
 * members have all been deleted reads as non-empty, passes every coherence check, and resolves to
 * nothing at runtime. Pruning is what makes that warning fire.
 *
 * ## Why every write here is `updateMany`
 *
 * These writes are a side effect of a question write, not the operation anyone asked for. The Topics
 * tab saves with `replaceTopics`, a `deleteMany` + `createMany`, so a concurrent save can remove the
 * row between the read below and the write. With `update` that is a P2025 — and a thrown query
 * inside a Postgres transaction aborts it, so a caller that wraps this in one would lose the
 * question write too. Losing a question because its membership lost a race is strictly worse than
 * the orphan we are preventing. A zero-row `updateMany` is not an error, so the race degrades to
 * exactly today's behaviour and the review queue's orphan banner reports it.
 *
 * `members` is a plain `Json` column with no version stamp, so a concurrent Topics-tab save can
 * still overwrite a membership written here. Accepted: an etag on a JSON blob is a lot of machinery
 * for a race between one admin's two open tabs, and the banner already reports the outcome.
 *
 * ## `source` is deliberately never stamped
 *
 * `scope-evaluation-apply.ts` stamps `source: 'manual'` on its topic writes, so copying it would
 * look right. It is not. `isEligibleForScopeCandidacy` and `launchability.ts` both gate on
 * `source: { not: 'seeded' }` to decide whether a version is untouched by Conditional Topics, so
 * flipping a seeded topic because a question landed in it would silently suppress the Routing
 * Analyst candidacy check for that version. There the admin approved a change to a topic's own
 * configuration; here they changed a *question*, and whether the topic is still an untouched
 * auto-seed is not something that decides.
 */

import { prisma } from '@/lib/db/client';
import { inheritTopicForQuestion } from '@/lib/app/questionnaire/scope/seed';
import {
  narrowTopicMembers,
  withTopicQuestionKey,
  withoutTopicQuestionKey,
  type TopicMembers,
} from '@/lib/app/questionnaire/scope/types';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

/**
 * The Prisma surface these helpers need — a structural `Pick`, not `Prisma.TransactionClient`, so
 * the global client and both shapes of transaction client this codebase produces all satisfy it
 * (the same reasoning `topic-routes.ts` writes down for its settings helpers).
 */
type DbClient = Pick<typeof prisma, 'appQuestionnaireTopic'>;

interface TopicForMembership {
  id: string;
  key: string;
  ordinal: number;
  members: TopicMembers;
}

/** A version's topics, narrowed. */
async function loadTopics(client: DbClient, versionId: string): Promise<TopicForMembership[]> {
  const rows = await client.appQuestionnaireTopic.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, key: true, ordinal: true, members: true },
  });
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    ordinal: row.ordinal,
    members: narrowTopicMembers(row.members),
  }));
}

/** Write one topic's members. Split out so every write in this module goes through `updateMany`. */
async function writeMembers(
  client: DbClient,
  topicId: string,
  members: TopicMembers
): Promise<void> {
  await client.appQuestionnaireTopic.updateMany({
    where: { id: topicId },
    data: { members: jsonInput(members) },
  });
}

/**
 * Put a newly created question in the topic its section-mates are in.
 *
 * Returns the topic key it joined, `null` when no topic claims any sibling (nothing could be
 * inferred, so the question is uncovered), or `undefined` when the version has no topics at all.
 * Three states, because "we could not decide" and "there was nothing to decide" read very
 * differently to an admin.
 *
 * The rule is `inheritTopicForQuestion` — `planDataSlotAttachment`'s majority-with-lowest-ordinal
 * tie-break, applied to a question. Guessing is the right default: with Conditional Topics on, the
 * alternative to a guess is a question that can never be asked.
 */
export async function inheritTopicMembership(
  client: DbClient,
  versionId: string,
  questionKey: string,
  siblingKeys: readonly string[]
): Promise<string | null | undefined> {
  const topics = await loadTopics(client, versionId);
  if (topics.length === 0) return undefined;

  const topicKey = inheritTopicForQuestion(topics, siblingKeys);
  if (!topicKey) return null;

  const topic = topics.find((t) => t.key === topicKey);
  if (!topic) return null;

  const next = withTopicQuestionKey(topic.members, questionKey);
  if (next !== topic.members) await writeMembers(client, topic.id, next);
  return topicKey;
}

/**
 * Give `newKey` the membership of `sourceKey` — every topic claiming the source claims the copy.
 *
 * For a split, where the two halves are one question reshaped: whatever the original was part of,
 * both halves are part of.
 */
export async function copyTopicMembership(
  client: DbClient,
  versionId: string,
  sourceKey: string,
  newKey: string
): Promise<void> {
  for (const topic of await loadTopics(client, versionId)) {
    if (!topic.members.questionKeys.includes(sourceKey)) continue;
    const next = withTopicQuestionKey(topic.members, newKey);
    if (next === topic.members) continue;
    await writeMembers(client, topic.id, next);
  }
}

/**
 * Remove a deleted question's key from every topic that claimed it.
 *
 * The emptied topic is left in place: it still carries a label, a phase and criteria an author
 * wrote, and `empty_topic` is the warning that says it now asks nothing.
 * `reconcileTopicsForVersion` does delete such topics, but it runs on a wholesale structure
 * rewrite, where the topic's subject is genuinely gone — not on one question being removed.
 */
export async function pruneTopicMembership(
  client: DbClient,
  versionId: string,
  questionKey: string
): Promise<void> {
  for (const topic of await loadTopics(client, versionId)) {
    const next = withoutTopicQuestionKey(topic.members, questionKey);
    if (next === topic.members) continue;
    await writeMembers(client, topic.id, next);
  }
}

/**
 * The keys of the questions a new question will sit beside — what its topic is inferred from.
 *
 * Section-scoped, because a section is the grouping every caller actually has to hand, and because
 * topics and sections align by construction on a freshly ingested questionnaire (ingest seeds one
 * `core` topic per section).
 */
export async function sectionQuestionKeys(
  client: Pick<typeof prisma, 'appQuestionSlot'>,
  sectionId: string
): Promise<string[]> {
  const rows = await client.appQuestionSlot.findMany({
    where: { sectionId },
    select: { key: true },
  });
  return rows.map((r) => r.key);
}
