/**
 * Route-local DB seam for the Routing Analyst's reviewable draft (Conditional Topics, P17.4).
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
  narrowConditionalTopicsSettings,
  narrowProposedTopicSet,
  type ConditionalTopicsSettings,
  type ProposedTopicSet,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { TOPIC_SELECT, toTopic } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import type { RoutingAnalysisDocument } from '@/lib/app/questionnaire/scope/analysis-prompt';
import {
  MAX_SUPPLEMENTARY_DOCUMENT_CHARS,
  SUPPLEMENTARY_TRUNCATION_MARKER,
} from '@/lib/app/questionnaire/scope/constants';

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
  settings: ConditionalTopicsSettings;
}

/**
 * Accept the reviewed proposal: write the topics live, merge the hard rules into the version's
 * settings, and clear the draft — in ONE transaction.
 *
 * Atomicity is the point. A half-applied accept (topics written, draft still pending) would leave
 * the admin looking at a review queue for work already done, and re-accepting would duplicate it.
 *
 * Four deliberate choices about what accept does and does not touch:
 *
 * - **Topics are replaced, not merged.** The reviewed proposal IS the set — the analyst was given
 *   the existing topics and told to revise them by reusing keys, so a merge here would re-introduce
 *   the duplicates that instruction exists to avoid.
 * - **`source` is stamped `analyst`**, so the Topics surface can still tell a machine-proposed topic
 *   from a hand-authored one after the fact.
 * - **`enabled` moves only when the admin says so, in this same act.** Accepting a proposal is an
 *   authoring act; turning the feature on is a decision about what respondents are asked. The
 *   accept dialog offers that decision — as an UNTICKED box, shown only when the proposal contains
 *   a conditional topic — and `body.enable` carries the answer. Without it, `enabled` is untouched,
 *   exactly as before. Nothing here can turn the feature OFF: the schema accepts only `true`.
 * - **`fallbackTopicKeys` and `checkTopicPreference` ride along when the analyst proposed them**
 *   (F17.23), on the same omitted-means-leave-alone / present-means-replace contract as `rules`.
 *   They are settings rather than topics, but they are read out of the same routing prose in the
 *   same pass — before this, a document that named a safe default or a blind-spot area came back as
 *   an unformalizable `gap`, which was the proposal admitting defeat about a setting the platform
 *   had implemented all along. `enabled` is still not among them.
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
      select: { conditionalTopics: true },
    });
    const current = narrowConditionalTopicsSettings(config?.conditionalTopics);

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

    const merged: ConditionalTopicsSettings = {
      ...current,
      rules,
      ...(body.maxConditionalTopics !== undefined
        ? { maxConditionalTopics: body.maxConditionalTopics }
        : {}),
      ...(body.fallbackTopicKeys !== undefined
        ? { fallbackTopicKeys: body.fallbackTopicKeys }
        : {}),
      ...(body.checkTopicPreference !== undefined
        ? { checkTopicPreference: body.checkTopicPreference }
        : {}),
      // One-way. An absent `enable` leaves the version's own value alone rather than resolving to
      // `false`, so accepting a second proposal on an already-live setup cannot silently switch
      // routing off mid-flight.
      ...(body.enable === true ? { enabled: true } : {}),
    };

    await tx.appQuestionnaireConfig.upsert({
      where: { versionId },
      update: { conditionalTopics: jsonInput(merged) },
      create: { versionId, conditionalTopics: jsonInput(merged) },
    });

    await tx.appQuestionnaireTopicDraft.deleteMany({ where: { versionId } });

    const rows = await tx.appQuestionnaireTopic.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });

    return { topics: rows.map(toTopic), settings: narrowConditionalTopicsSettings(merged) };
  });
}

/** Everything the analyst reads. `null` when the version does not exist or has no questions. */
export interface RoutingAnalysisRouteInput {
  goal: string | null;
  audience?: unknown;
  questions: { key: string; prompt: string; sectionTitle?: string }[];
  dataSlots: { key: string; name: string; theme?: string }[];
  /** The current instrument first, then any companion documents, in attachment order. */
  documents: RoutingAnalysisDocument[];
  existingTopics: Topic[];
}

/**
 * Assemble the analyst's input from the version.
 *
 * The instrument is the **newest primary** document, not the newest row: re-ingest adds a row
 * rather than replacing it, and an analyst reading the superseded upload would propose routing for
 * an instrument that is no longer the one being asked.
 *
 * Beside it travel the version's **supplementary** documents — companions an admin attached because
 * the instrument arrived as more than one file (a question bank plus a separate routing memo). They
 * are ordered oldest-first, which is attachment order, and share one character budget; a document
 * that does not fit is cut with a marked seam rather than dropped silently, because a routing rule
 * that vanished without trace is exactly the failure this is meant to end.
 *
 * The budget covers the companions only. The primary document is passed in full, as it always has
 * been — bounding it here would change what the analyst proposes on versions nobody has touched.
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
        select: { fileName: true, extractedText: true, role: true },
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

  return {
    goal: version.goal,
    audience: version.audience ?? undefined,
    questions,
    dataSlots: version.dataSlots.map((slot) => ({
      key: slot.key,
      name: slot.name,
      ...(slot.theme ? { theme: slot.theme } : {}),
    })),
    documents: selectAnalystDocuments(version.sourceDocuments),
    existingTopics: version.topics.map(toTopic),
  };
}

/** One source-document row, as much of it as {@link selectAnalystDocuments} needs. */
type SourceDocumentRow = { fileName: string; extractedText: string; role: string };

/**
 * Choose and budget the documents the analyst reads: the newest primary, then every supplementary
 * one in attachment order, truncated as a set.
 *
 * Rows arrive newest-first (the query's `orderBy`). A version whose rows all predate the `role`
 * column reads exactly as it did before — they default to `primary`, so the first row is the newest
 * primary and there is nothing else to add.
 */
export function selectAnalystDocuments(
  rows: readonly SourceDocumentRow[]
): RoutingAnalysisDocument[] {
  const documents: RoutingAnalysisDocument[] = [];

  const primary = rows.find((row) => row.role !== 'supplementary');
  if (primary) {
    documents.push({ role: 'primary', fileName: primary.fileName, text: primary.extractedText });
  }

  // Oldest-first: the companion attached first is the one the admin has already seen the analyst
  // act on, so it is the one that keeps its text when the budget runs out.
  const supplementary = rows.filter((row) => row.role === 'supplementary').reverse();

  let remaining = MAX_SUPPLEMENTARY_DOCUMENT_CHARS;
  for (const row of supplementary) {
    if (remaining <= 0) {
      documents.push({
        role: 'supplementary',
        fileName: row.fileName,
        text: '',
        omitted: true,
      });
      continue;
    }
    const truncated = row.extractedText.length > remaining;
    documents.push({
      role: 'supplementary',
      fileName: row.fileName,
      text: truncated
        ? row.extractedText.slice(0, remaining) + SUPPLEMENTARY_TRUNCATION_MARKER
        : row.extractedText,
      ...(truncated ? { truncated: true } : {}),
    });
    remaining -= row.extractedText.length;
  }

  return documents;
}
