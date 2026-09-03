/**
 * Route-local DB seam for Conditional Topics (P17) — the `lib/app/questionnaire/scope/**` module stays
 * Prisma-free.
 *
 * Loads a version's topics into the client-safe {@link Topic}, replaces the set on a bulk save, and
 * patches the `conditionalTopics` settings blob. Sibling of `data-slot-routes.ts`, deliberately shaped
 * the same way.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import type {
  TopicInput,
  ConditionalTopicsSettingsPatch,
} from '@/lib/app/questionnaire/scope/schemas';
import {
  TOPIC_DEPTHS,
  TOPIC_PHASES,
  TOPIC_SOURCES,
  narrowConditionalTopicsSettings,
  narrowTopicMembers,
  narrowTopicTrigger,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicSource,
} from '@/lib/app/questionnaire/scope/types';
import { DEFAULT_QUESTIONNAIRE_CONFIG, narrowToEnum } from '@/lib/app/questionnaire/types';

/** Shared select projecting a topic row. */
export const TOPIC_SELECT = {
  id: true,
  key: true,
  label: true,
  description: true,
  phase: true,
  criteria: true,
  depth: true,
  members: true,
  ordinal: true,
  source: true,
  trigger: true,
} as const;

type TopicRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  phase: string;
  criteria: string | null;
  depth: string;
  members: unknown;
  ordinal: number;
  source: string;
  trigger: unknown;
};

/** Project a `TOPIC_SELECT` row to the pure {@link Topic}. */
export function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description,
    phase: narrowToEnum(row.phase, TOPIC_PHASES, 'core'),
    criteria: row.criteria,
    depth: narrowToEnum(row.depth, TOPIC_DEPTHS, 'full'),
    members: narrowTopicMembers(row.members),
    ordinal: row.ordinal,
    source: narrowToEnum(row.source, TOPIC_SOURCES, 'manual'),
    trigger: narrowTopicTrigger(row.trigger),
  };
}

/** All topics for a version, ordinal order. */
export async function loadTopics(versionId: string): Promise<Topic[]> {
  const rows = await prisma.appQuestionnaireTopic.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: TOPIC_SELECT,
  });
  return rows.map(toTopic);
}

/**
 * The Prisma surface these two settings helpers need — a structural `Pick`, not `Prisma.TransactionClient`,
 * so both the global client and either shape of transaction client this codebase produces satisfy it:
 * `prisma.$transaction`'s own callback client, and `executeTransaction`'s (`lib/db/utils.ts`), whose
 * callback type additionally omits `$transaction` and is therefore NOT assignable to
 * `Prisma.TransactionClient` itself. A caller can run a read-modify-write inside its own transaction
 * either way (e.g. the scope-evaluation apply engine writes a settings op + stamps the finding applied
 * atomically; the definition importer seeds Conditional Topics settings inside its create-only transaction).
 */
type DbClient = Pick<typeof prisma, 'appQuestionnaireConfig'>;

/** A version's resolved Conditional Topics settings — defaults when no config row exists. */
export async function loadConditionalTopicsSettings(
  versionId: string,
  client: DbClient = prisma
): Promise<ConditionalTopicsSettings> {
  const config = await client.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { conditionalTopics: true },
  });
  return narrowConditionalTopicsSettings(config?.conditionalTopics);
}

/**
 * The version's per-slot re-ask cap (G03).
 *
 * Read on its own rather than folded into {@link loadConditionalTopicsSettings} because it belongs to a
 * different blob and a different tab: it governs the interviewer, not the routing. Only the Topics
 * tab needs it, and only to say when a follow-up limit set there cannot bind.
 */
export async function loadMaxDataSlotAttempts(versionId: string): Promise<number> {
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { maxDataSlotAttempts: true },
  });
  return config?.maxDataSlotAttempts ?? DEFAULT_QUESTIONNAIRE_CONFIG.maxDataSlotAttempts;
}

/**
 * Build one `AppQuestionnaireTopic` create row from a `TopicInput`-shaped topic, given the ordinal
 * and source a caller decides (a bulk save always stamps `manual` + array index; the definition
 * importer carries the file's own `ordinal`/`source` through instead). Shared so the two call sites
 * — {@link replaceTopics} below and the definition-import persister
 * (`_lib/import-definition.ts`) — can't drift on field mapping.
 */
export function buildTopicCreateInput(
  versionId: string,
  topic: Pick<
    TopicInput,
    | 'key'
    | 'label'
    | 'description'
    | 'phase'
    | 'criteria'
    | 'depth'
    | 'questionKeys'
    | 'dataSlotKeys'
    | 'trigger'
  >,
  ordinal: number,
  source: TopicSource
): Prisma.AppQuestionnaireTopicCreateManyInput {
  return {
    versionId,
    key: topic.key,
    label: topic.label,
    phase: topic.phase,
    criteria: topic.criteria,
    depth: topic.depth,
    members: jsonInput({ questionKeys: topic.questionKeys, dataSlotKeys: topic.dataSlotKeys }),
    ordinal,
    source,
    ...(topic.description !== null ? { description: topic.description } : {}),
    // F17.31a. Carried through every write path, not just the analyst's: the bulk save replaces the
    // whole set from what the Topics tab sends back, so a trigger this helper dropped would be
    // deleted by an admin renaming an unrelated topic.
    ...(topic.trigger ? { trigger: jsonInput(topic.trigger) } : {}),
  };
}

/**
 * Replace a version's whole topic set with the reviewed one.
 *
 * Delete-then-write rather than a diff: the admin surface submits the complete set, so reconciling
 * row-by-row would add a merge nobody asked for and could not express "delete this one" anyway.
 * `source` is stamped `manual` on every written row — once a human has reviewed the set, calling
 * any of it an untouched auto-seed would be a lie.
 */
export async function replaceTopics(versionId: string, topics: TopicInput[]): Promise<Topic[]> {
  return executeTransaction(async (tx) => {
    await tx.appQuestionnaireTopic.deleteMany({ where: { versionId } });
    if (topics.length > 0) {
      await tx.appQuestionnaireTopic.createMany({
        data: topics.map((t, i) => buildTopicCreateInput(versionId, t, i, 'manual')),
      });
    }
    const rows = await tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });
    return rows.map(toTopic);
  });
}

/**
 * Merge a settings patch onto the version's current Conditional Topics settings.
 *
 * Read-narrow-merge-write rather than a blind overwrite, so the Settings tab can send one knob
 * without resending the rest — and so a legacy or partial blob is normalised on the way through.
 * Creates the config row when the version has none (upsert), since a version with no config row is
 * a perfectly ordinary state that should not block turning the feature on.
 */
export async function patchConditionalTopicsSettings(
  versionId: string,
  patch: ConditionalTopicsSettingsPatch,
  client: DbClient = prisma
): Promise<ConditionalTopicsSettings> {
  const current = await loadConditionalTopicsSettings(versionId, client);

  const merged: ConditionalTopicsSettings = { ...current, ...patch };

  await client.appQuestionnaireConfig.upsert({
    where: { versionId },
    update: { conditionalTopics: jsonInput(merged) },
    create: { versionId, conditionalTopics: jsonInput(merged) },
  });

  // Narrow on the way out so the caller sees exactly what a later read will produce — clamped
  // numbers, dropped blanks, sorted rules — rather than the un-normalised object it just sent.
  return narrowConditionalTopicsSettings(merged);
}
