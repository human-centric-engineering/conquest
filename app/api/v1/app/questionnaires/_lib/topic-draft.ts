/**
 * Route-local DB seam for the Routing Analyst's reviewable draft (Adaptive Scope, P17.4).
 *
 * `AppQuestionnaireTopicDraft` holds ONE pending proposal per version and is explicitly not live:
 * the runtime scope resolver, the planner and the launch gate read only `AppQuestionnaireTopic`.
 * That is the same contract `AppDataSlotDraft` follows, for the same reason — proposing topics runs
 * a paid LLM call over a whole source document, and holding the result only in the admin's browser
 * loses it on navigation.
 *
 * The `lib/app/questionnaire/scope/**` modules stay Prisma-free; this is their DB seam.
 */

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import type { AcceptTopicDraftBody } from '@/lib/app/questionnaire/scope/schemas';
import {
  narrowAdaptiveScopeSettings,
  narrowProposedTopicSet,
  type AdaptiveScopeSettings,
  type ProposedTopicSet,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { TOPIC_SELECT, toTopic } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/** The version's pending proposal, or null when there is none (or it no longer parses). */
export async function loadTopicDraft(versionId: string): Promise<ProposedTopicSet | null> {
  const row = await prisma.appQuestionnaireTopicDraft.findUnique({
    where: { versionId },
    select: { topics: true },
  });
  return row ? narrowProposedTopicSet(row.topics) : null;
}

/**
 * Replace the version's pending proposal with a fresh run's output.
 *
 * One draft per version, wholesale: a second analysis run supersedes the first rather than merging
 * with it. Merging two proposals would produce a set neither run actually stands behind, and the
 * admin would have no way to tell which half came from where.
 */
export async function saveTopicDraft(
  versionId: string,
  draft: ProposedTopicSet
): Promise<ProposedTopicSet> {
  await prisma.appQuestionnaireTopicDraft.upsert({
    where: { versionId },
    update: { topics: jsonInput(draft) },
    create: { versionId, topics: jsonInput(draft) },
  });
  return draft;
}

/** Discard the pending proposal. Idempotent — discarding nothing is not an error. */
export async function discardTopicDraft(versionId: string): Promise<void> {
  await prisma.appQuestionnaireTopicDraft.deleteMany({ where: { versionId } });
}

/** What an accept wrote back. */
export interface AcceptTopicDraftResult {
  topics: Topic[];
  settings: AdaptiveScopeSettings;
}

/**
 * Accept the reviewed proposal: write the topics live, merge the hard rules into the version's
 * settings, and clear the draft — in ONE transaction.
 *
 * Atomicity is the point. A half-applied accept (topics written, draft still pending) would leave
 * the admin looking at a review queue for work already done, and re-accepting would duplicate it.
 *
 * Three deliberate choices about what accept does and does not touch:
 *
 * - **Topics are replaced, not merged.** The reviewed proposal IS the set — the analyst was given
 *   the existing topics and told to revise them by reusing keys, so a merge here would re-introduce
 *   the duplicates that instruction exists to avoid.
 * - **`source` is stamped `analyst`**, so the Topics surface can still tell a machine-proposed topic
 *   from a hand-authored one after the fact.
 * - **`enabled` is never touched.** Accepting a proposal is an authoring act; turning the feature on
 *   is a decision about what respondents are asked, and it stays the admin's explicit choice.
 */
export async function acceptTopicDraft(
  versionId: string,
  body: AcceptTopicDraftBody
): Promise<AcceptTopicDraftResult> {
  return executeTransaction(async (tx) => {
    await tx.appQuestionnaireTopic.deleteMany({ where: { versionId } });
    if (body.topics.length > 0) {
      await tx.appQuestionnaireTopic.createMany({
        data: body.topics.map((t, i) => ({
          versionId,
          key: t.key,
          label: t.label,
          phase: t.phase,
          criteria: t.criteria,
          depth: t.depth,
          members: jsonInput({ questionKeys: t.questionKeys, dataSlotKeys: t.dataSlotKeys }),
          ordinal: i,
          source: 'analyst',
          ...(t.description !== null ? { description: t.description } : {}),
        })),
      });
    }

    const config = await tx.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { adaptiveScope: true },
    });
    const current = narrowAdaptiveScopeSettings(config?.adaptiveScope);

    // Rules REPLACE rather than append. The analyst read the document's routing instructions as one
    // piece and proposed the rules they describe; appending would leave an admin who re-ran the
    // analysis with two copies of every rule and no way to tell which run authored which.
    const rules: ScopeRule[] = (body.rules ?? current.rules).map((r, i) => ({
      id: 'id' in r && typeof r.id === 'string' && r.id.length > 0 ? r.id : `rule-${i}`,
      dataSlotKey: r.dataSlotKey,
      operator: r.operator,
      value: r.value ?? null,
      action: r.action,
      topicKey: r.topicKey,
      ordinal: i,
    }));

    const merged: AdaptiveScopeSettings = {
      ...current,
      rules,
      ...(body.maxConditionalTopics !== undefined
        ? { maxConditionalTopics: body.maxConditionalTopics }
        : {}),
    };

    await tx.appQuestionnaireConfig.upsert({
      where: { versionId },
      update: { adaptiveScope: jsonInput(merged) },
      create: { versionId, adaptiveScope: jsonInput(merged) },
    });

    await tx.appQuestionnaireTopicDraft.deleteMany({ where: { versionId } });

    const rows = await tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });

    return { topics: rows.map(toTopic), settings: narrowAdaptiveScopeSettings(merged) };
  });
}

/** Everything the analyst reads. `null` when the version does not exist or has no questions. */
export interface RoutingAnalysisRouteInput {
  goal: string | null;
  audience?: unknown;
  questions: { key: string; prompt: string; sectionTitle?: string }[];
  dataSlots: { key: string; name: string; theme?: string }[];
  documentText?: string;
  documentFileName?: string;
  existingTopics: Topic[];
}

/**
 * Assemble the analyst's input from the version.
 *
 * The source document is the **newest** one on the version, not the first: re-ingest adds a row
 * rather than replacing it, and an analyst reading the superseded upload would propose routing for
 * an instrument that is no longer the one being asked.
 */
export async function buildRoutingAnalysisInput(
  questionnaireId: string,
  versionId: string
): Promise<RoutingAnalysisRouteInput | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      goal: true,
      audience: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          title: true,
          questions: { orderBy: { ordinal: 'asc' }, select: { key: true, prompt: true } },
        },
      },
      dataSlots: { orderBy: { ordinal: 'asc' }, select: { key: true, name: true, theme: true } },
      sourceDocuments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { fileName: true, extractedText: true },
      },
      topics: { orderBy: { ordinal: 'asc' }, select: TOPIC_SELECT },
    },
  });
  if (!version) return null;

  const questions = version.sections.flatMap((section) =>
    section.questions.map((question) => ({
      key: question.key,
      prompt: question.prompt,
      ...(section.title ? { sectionTitle: section.title } : {}),
    }))
  );
  if (questions.length === 0) return null;

  const document = version.sourceDocuments[0];

  return {
    goal: version.goal,
    audience: version.audience ?? undefined,
    questions,
    dataSlots: version.dataSlots.map((slot) => ({
      key: slot.key,
      name: slot.name,
      ...(slot.theme ? { theme: slot.theme } : {}),
    })),
    ...(document
      ? { documentText: document.extractedText, documentFileName: document.fileName }
      : {}),
    existingTopics: version.topics.map(toTopic),
  };
}
