/**
 * Topic auto-seeding (P17) — pure planning of "one topic per section".
 *
 * Every freshly-ingested version gets a complete topic set for free: one `core` topic per extracted
 * section, holding that section's questions and any data slots mapped to them. Authoring Adaptive
 * Scope then becomes **editing** — change a phase, write a criteria sentence — rather than building
 * a parallel structure from nothing, which is the difference between a feature admins use and one
 * they look at once.
 *
 * Seeded topics are all `core` (always asked) and `conditionalTopics.enabled` defaults false, so the
 * seed changes nothing about how the questionnaire runs. That is the point: seeding is preparation,
 * not activation.
 *
 * Pure — no Prisma. The caller supplies the section/question/data-slot projections and writes the
 * rows. Kept separate from `persist.ts` so the seeding rules are unit-testable without a database.
 */

import { nextAvailableKey, slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import {
  TOPIC_LABEL_MAX_LENGTH,
  type TopicMembers,
  type TopicPhase,
  type TopicSource,
} from '@/lib/app/questionnaire/scope/types';

/** A section as the seeder reads it. */
export interface SeedSection {
  id: string;
  title: string;
  ordinal: number;
}

/** A question as the seeder reads it. */
export interface SeedQuestion {
  key: string;
  sectionId: string;
}

/**
 * A data slot as the seeder reads it, with the question keys it abstracts over.
 *
 * A data slot lands in the topic that owns most of the questions it maps to. Slots routinely span
 * a section boundary (one probe capturing an item from two sections), and a slot has to belong
 * somewhere — putting it where most of its questions are keeps the topic coherent, and the
 * first-wins tie-break keeps it deterministic.
 */
export interface SeedDataSlot {
  key: string;
  mappedQuestionKeys: string[];
}

/**
 * A topic as the ATTACHMENT pass reads it — anything with a key, an order and question membership.
 *
 * Deliberately structural rather than the full {@link Topic}: the same rule has to run over topics
 * being built from scratch (`planSeededTopics`, below) and over topics already in the database
 * (`attachDataSlotsForVersion`), and neither should have to construct the other's shape.
 */
export interface AttachTopic {
  key: string;
  ordinal: number;
  members: { questionKeys: readonly string[]; dataSlotKeys: readonly string[] };
}

/**
 * Decide which topic each unattached data slot belongs to.
 *
 * Returns `topicKey → slot keys to ADD`. Topics absent from the map need no change.
 *
 * ## Why this exists at all
 *
 * Topics are seeded during ingest, and ingest creates no data slots — those are generated
 * afterwards, as a separate admin step. So a seeded topic's `dataSlotKeys` is always `[]` at birth,
 * and without this pass it stays that way forever: nothing else ever revisits membership. The
 * symptom is a questionnaire where every data slot belongs to no topic, which means the conversation
 * would target none of them the moment conditional topics is switched on.
 *
 * Running this wherever slots are written is what makes the authoring ORDER stop mattering — slots
 * before topics, topics before slots, or slots regenerated years later all converge on the same
 * membership.
 *
 * ## The rule, and why it is safe to run repeatedly
 *
 * A slot lands in the topic owning most of the questions it maps to, ties breaking to the lower
 * ordinal so the result never depends on Map insertion order. Slots routinely span a topic boundary
 * (one probe capturing an item from two sections) and a slot has to belong somewhere; putting it
 * where most of its questions are keeps the topic coherent.
 *
 * **Additive only, and never a move.** A slot already claimed by ANY topic is skipped entirely, so
 * this can never overrule an admin who placed it deliberately, never relocate a slot when questions
 * shift beneath it, and never produce a different answer on a second run. A slot whose questions no
 * topic claims is skipped too — there is no defensible home for it, and the coherence findings
 * report it where it can be fixed. A key appearing twice in `dataSlots` is proposed once.
 */
export function planDataSlotAttachment(input: {
  topics: readonly AttachTopic[];
  dataSlots: readonly SeedDataSlot[];
}): Map<string, string[]> {
  const additions = new Map<string, string[]>();
  if (input.topics.length === 0 || input.dataSlots.length === 0) return additions;

  // Lowest ordinal first, so the tie-break falls out of iteration order rather than a comparator.
  const ordered = [...input.topics].sort((a, b) => a.ordinal - b.ordinal);

  const owningTopics = new Map<string, string[]>();
  for (const topic of ordered) {
    for (const qKey of topic.members.questionKeys) {
      const list = owningTopics.get(qKey);
      if (list) list.push(topic.key);
      else owningTopics.set(qKey, [topic.key]);
    }
  }

  const alreadyAttached = new Set<string>();
  for (const topic of input.topics) {
    for (const key of topic.members.dataSlotKeys) alreadyAttached.add(key);
  }

  for (const slot of input.dataSlots) {
    if (alreadyAttached.has(slot.key)) continue;

    const counts = new Map<string, number>();
    for (const qKey of slot.mappedQuestionKeys) {
      for (const topicKey of owningTopics.get(qKey) ?? []) {
        counts.set(topicKey, (counts.get(topicKey) ?? 0) + 1);
      }
    }
    if (counts.size === 0) continue;

    let bestKey: string | null = null;
    let best = 0;
    for (const topic of ordered) {
      const n = counts.get(topic.key) ?? 0;
      if (n > best) {
        best = n;
        bestKey = topic.key;
      }
    }
    if (!bestKey) continue;

    // Mark it attached before moving on, so a `dataSlots` list that names the same key twice
    // (a caller passing duplicates) proposes it once rather than listing it twice on the topic.
    alreadyAttached.add(slot.key);

    const list = additions.get(bestKey);
    if (list) list.push(slot.key);
    else additions.set(bestKey, [slot.key]);
  }

  return additions;
}

/** One topic the seeder proposes. Shaped for a direct `createMany`. */
export interface SeededTopic {
  key: string;
  label: string;
  phase: TopicPhase;
  members: TopicMembers;
  ordinal: number;
  source: TopicSource;
}

/**
 * Plan one `core` topic per section.
 *
 * Sections with no questions are skipped — an empty topic is noise on the authoring surface and
 * can never be chosen, so seeding one would only ever be something to delete.
 *
 * Keys are slugified from the section title and de-duplicated against `existingKeys`, so re-running
 * the seed on a version that already has topics adds the missing ones instead of colliding.
 */
export function planSeededTopics(input: {
  sections: readonly SeedSection[];
  questions: readonly SeedQuestion[];
  dataSlots?: readonly SeedDataSlot[];
  existingKeys?: ReadonlySet<string>;
}): SeededTopic[] {
  const questionKeysBySection = new Map<string, string[]>();
  for (const q of input.questions) {
    const list = questionKeysBySection.get(q.sectionId);
    if (list) list.push(q.key);
    else questionKeysBySection.set(q.sectionId, [q.key]);
  }

  const ordered = [...input.sections].sort((a, b) => a.ordinal - b.ordinal);

  const taken = new Set(input.existingKeys ?? []);
  const topics: SeededTopic[] = [];

  for (const section of ordered) {
    const questionKeys = questionKeysBySection.get(section.id) ?? [];
    if (questionKeys.length === 0) continue;

    const key = nextAvailableKey(slugifyKey(section.title), taken);
    taken.add(key);

    topics.push({
      key,
      label: section.title.trim().slice(0, TOPIC_LABEL_MAX_LENGTH) || key,
      phase: 'core',
      members: { dataSlotKeys: [], questionKeys },
      ordinal: topics.length,
      source: 'seeded',
    });
  }

  // Second pass: attribute the data slots. Delegated to `planDataSlotAttachment` so a seeded topic
  // and a topic that has been in the database for a year are given their slots by the same rule —
  // topics here are 1:1 with sections and carry the section's ordinal, so attributing over topic
  // membership resolves identically to attributing over sections.
  const byKey = new Map(topics.map((t) => [t.key, t]));
  for (const [topicKey, slotKeys] of planDataSlotAttachment({
    topics,
    dataSlots: input.dataSlots ?? [],
  })) {
    const topic = byKey.get(topicKey);
    if (topic) topic.members.dataSlotKeys.push(...slotKeys);
  }

  return topics;
}
