/**
 * Topic auto-seeding (P17) — pure planning of "one topic per section".
 *
 * Every freshly-ingested version gets a complete topic set for free: one `core` topic per extracted
 * section, holding that section's questions and any data slots mapped to them. Authoring Adaptive
 * Scope then becomes **editing** — change a phase, write a criteria sentence — rather than building
 * a parallel structure from nothing, which is the difference between a feature admins use and one
 * they look at once.
 *
 * Seeded topics are all `core` (always asked) and `adaptiveScope.enabled` defaults false, so the
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

  // sectionId → the topic being built for it, so data slots can be attributed in a second pass.
  const sectionOfQuestion = new Map<string, string>();
  for (const q of input.questions) sectionOfQuestion.set(q.key, q.sectionId);

  const taken = new Set(input.existingKeys ?? []);
  const topics: SeededTopic[] = [];
  const bySection = new Map<string, SeededTopic>();

  for (const section of ordered) {
    const questionKeys = questionKeysBySection.get(section.id) ?? [];
    if (questionKeys.length === 0) continue;

    const key = nextAvailableKey(slugifyKey(section.title), taken);
    taken.add(key);

    const topic: SeededTopic = {
      key,
      label: section.title.trim().slice(0, TOPIC_LABEL_MAX_LENGTH) || key,
      phase: 'core',
      members: { dataSlotKeys: [], questionKeys },
      ordinal: topics.length,
      source: 'seeded',
    };
    topics.push(topic);
    bySection.set(section.id, topic);
  }

  // Second pass: attribute each data slot to the section owning most of its mapped questions.
  for (const slot of input.dataSlots ?? []) {
    const counts = new Map<string, number>();
    for (const qKey of slot.mappedQuestionKeys) {
      const sectionId = sectionOfQuestion.get(qKey);
      if (!sectionId) continue;
      counts.set(sectionId, (counts.get(sectionId) ?? 0) + 1);
    }
    if (counts.size === 0) continue;

    let bestSection: string | null = null;
    let best = 0;
    // Iterate the sections in ordinal order so an exact tie resolves to the earlier section rather
    // than to Map insertion order, which depends on the question list's arrangement.
    for (const section of ordered) {
      const n = counts.get(section.id) ?? 0;
      if (n > best) {
        best = n;
        bestSection = section.id;
      }
    }
    if (!bestSection) continue;

    const topic = bySection.get(bestSection);
    if (topic && !topic.members.dataSlotKeys.includes(slot.key)) {
      topic.members.dataSlotKeys.push(slot.key);
    }
  }

  return topics;
}
